import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  type TicketsFile,
  type Ticket,
  type State,
  type Config,
  type Hooks,
  type PendingQuestion,
  type LoopConfig,
  type Pacing,
  parseTicketsFile,
  validateTicketDependencies,
  TicketSchema,
} from "./schemas.js";
import { resolveAndValidateImages, buildImagePromptSection } from "./images.js";
import { stateManager } from "./state.js";
import { markTicketCompleteInFile } from "./tickets-io.js";
import {
  claude,
  getLastRateLimitResetsAt,
  clearRateLimitResetsAt,
} from "./claude.js";
import type { AgentProvider } from "./agent-provider.js";
import { hookExecutor, type HookContext } from "./hooks.js";
import type { Multiplexer } from "../messaging/multiplexer.js";
import { logger } from "../utils/logger.js";
import { cleanupSessionLogs } from "../utils/session-report.js";
import {
  isRateLimitError,
  shouldFallback,
  calculateRateLimitWait,
} from "./rate-limit-detection.js";
import { evaluateCondition, type ConditionResult } from "./loop-condition.js";
import {
  createMemoryMonitor,
  getMemorySnapshot,
  getDiskSnapshot,
  tryGarbageCollect,
  type MemoryMonitor,
} from "../utils/memory-monitor.js";
import { processRegistry } from "../utils/process-lifecycle.js";
import { interruptibleDelay } from "../utils/interruptible-delay.js";
import { formatDuration } from "../utils/duration.js";

// =============================================================================
// Types and Interfaces
// =============================================================================

export interface OrchestratorOptions {
  projectRoot: string;
  ticketsFile: string;
  multiplexer: Multiplexer;
  dryRun?: boolean;
  verbose?: boolean;
  /** AI coding agent to use. Defaults to Claude Code if not specified. */
  agent?: AgentProvider;
}

export interface OrchestratorEvents {
  "ticket:start": [ticket: Ticket];
  "ticket:plan-generated": [ticket: Ticket, plan: string];
  "ticket:approved": [ticket: Ticket];
  "ticket:rejected": [ticket: Ticket, reason?: string];
  "ticket:executing": [ticket: Ticket];
  "ticket:completed": [ticket: Ticket];
  "ticket:failed": [ticket: Ticket, error: string];
  "ticket:skipped": [ticket: Ticket];
  "ticket:output": [ticket: Ticket, text: string];
  "ticket:event": [
    ticket: Ticket,
    event: { type: string; toolName?: string; message?: string },
  ];
  question: [ticket: Ticket, question: string];
  "queue:start": [];
  "queue:complete": [];
  "queue:paused": [];
  "loop:iteration-start": [
    ticket: Ticket,
    iteration: number,
    maxIterations: number,
  ];
  "loop:iteration-complete": [
    ticket: Ticket,
    iteration: number,
    conditionMet: boolean,
  ];
  "loop:condition-failed": [ticket: Ticket, iteration: number, error: string];
  "pacing:delay-start": [reason: string, durationMs: number, ticketId?: string];
  "pacing:delay-tick": [
    reason: string,
    elapsedMs: number,
    remainingMs: number,
    ticketId?: string,
  ];
  "pacing:delay-end": [
    reason: string,
    completed: boolean,
    elapsedMs: number,
    ticketId?: string,
  ];
  error: [error: Error];
}

export interface Orchestrator extends EventEmitter<OrchestratorEvents> {
  start(): Promise<void>;
  resume(): Promise<void>;
  pause(): void;
  stop(): Promise<void>;
  skipTicket(ticketId: string): Promise<void>;
  approveTicket(ticketId: string): Promise<void>;
  rejectTicket(ticketId: string, reason?: string): Promise<void>;
  answerQuestion(questionId: string, answer: string): Promise<void>;
  getStatus(): { state: State; currentTicket?: Ticket };
  isRunning(): boolean;
  queueTicket(ticket: Ticket): Promise<void>;
  getTickets(): Ticket[];
}

// =============================================================================
// Internal Types
// =============================================================================

interface ApprovalResult {
  approved: boolean;
  rejectionReason?: string;
}

interface PendingApprovalResolvers {
  resolve: (result: ApprovalResult) => void;
  reject: (error: Error) => void;
}

interface PendingQuestionResolvers {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}

// =============================================================================
// Orchestrator Implementation
// =============================================================================

class OrchestratorImpl
  extends EventEmitter<OrchestratorEvents>
  implements Orchestrator
{
  private readonly projectRoot: string;
  private readonly ticketsFilePath: string;
  private readonly multiplexer: Multiplexer;
  private readonly dryRun: boolean;
  private readonly verbose: boolean;
  private readonly agent: AgentProvider;

  private ticketsFile: TicketsFile | null = null;
  private state: State | null = null;
  private running = false;
  private pauseRequested = false;
  private stopRequested = false;
  private dynamicTickets: Ticket[] = [];
  private suppressCompletion = false;

  private memoryMonitor: MemoryMonitor | null = null;
  private pendingApprovals = new Map<string, PendingApprovalResolvers>();
  private pendingQuestionAnswers = new Map<string, PendingQuestionResolvers>();

  constructor(options: OrchestratorOptions) {
    super();
    this.projectRoot = options.projectRoot;
    this.ticketsFilePath = options.ticketsFile;
    this.multiplexer = options.multiplexer;
    this.dryRun = options.dryRun ?? false;
    this.verbose = options.verbose ?? false;
    this.agent = options.agent ?? claude;
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Orchestrator is already running");
    }

    logger.info("Starting orchestrator", { projectRoot: this.projectRoot });

    try {
      // Only load tickets file on first run (when ticketsFile is null)
      if (!this.ticketsFile) {
        await this.loadTicketsFile();
        await stateManager.init(this.projectRoot);
      }
      this.state = await stateManager.load(this.projectRoot);

      this.running = true;
      this.pauseRequested = false;
      this.stopRequested = false;

      const config = this.ticketsFile!.config;
      if (config.memoryWarningMb > 0 || config.memoryCriticalMb > 0) {
        this.memoryMonitor = createMemoryMonitor();
        this.memoryMonitor.start({
          intervalSec: config.memoryCheckIntervalSec,
          warningMb: config.memoryWarningMb,
          criticalMb: config.memoryCriticalMb,
          onWarning: (snapshot) => {
            logger.warn("Memory warning threshold hit", {
              rssMb: snapshot.rssMb.toFixed(1),
              warningMb: config.memoryWarningMb,
            });
            this.pauseRequested = true;
          },
          onCritical: (snapshot) => {
            logger.error("Memory CRITICAL - aborting current execution", {
              rssMb: snapshot.rssMb.toFixed(1),
              criticalMb: config.memoryCriticalMb,
            });
            claude.abort();
            this.pauseRequested = true;
          },
          getChildPids: () => processRegistry.getActivePids(),
        });
      }

      this.emit("queue:start");
      await this.runQueue();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("Failed to start orchestrator", { error: error.message });
      this.emit("error", error);
      throw error;
    }
  }

  async resume(): Promise<void> {
    if (this.running) {
      throw new Error("Orchestrator is already running");
    }

    logger.info("Resuming orchestrator", { projectRoot: this.projectRoot });

    try {
      await this.loadTicketsFile();
      this.state = await stateManager.load(this.projectRoot);

      if (!this.state.currentTicketId) {
        logger.info("No ticket to resume, starting fresh");
        return this.start();
      }

      this.running = true;
      this.pauseRequested = false;
      this.stopRequested = false;

      this.emit("queue:start");
      await this.resumeFromState();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("Failed to resume orchestrator", { error: error.message });
      this.emit("error", error);
      throw error;
    }
  }

  pause(): void {
    if (!this.running) {
      logger.warn("Cannot pause: orchestrator is not running");
      return;
    }

    logger.info("Pause requested");
    this.pauseRequested = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      logger.debug("Stop called but orchestrator not running");
      return;
    }

    logger.info("Stop requested");
    this.memoryMonitor?.stop();
    this.stopRequested = true;
    this.pauseRequested = true;

    this.agent.abort();

    if (this.state) {
      await stateManager.update(this.projectRoot, { pauseRequested: true });
    }

    this.running = false;
    this.emit("queue:paused");
  }

  async skipTicket(ticketId: string): Promise<void> {
    logger.info("Skipping ticket", { ticketId });

    const ticket = this.findTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    ticket.status = "skipped";
    await this.saveTicketsFile();

    this.emit("ticket:skipped", ticket);
    this.multiplexer
      .broadcastStatus({
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        status: "skipped",
      })
      .catch((err) =>
        logger.warn("Failed to broadcast status", { error: String(err) }),
      );
  }

  async approveTicket(ticketId: string): Promise<void> {
    const planId = this.getPlanIdForTicket(ticketId);
    const pending = this.pendingApprovals.get(planId);

    if (!pending) {
      throw new Error(`No pending approval for ticket: ${ticketId}`);
    }

    logger.info("Manually approving ticket", { ticketId });
    pending.resolve({ approved: true });
    this.pendingApprovals.delete(planId);
  }

  async rejectTicket(ticketId: string, reason?: string): Promise<void> {
    const planId = this.getPlanIdForTicket(ticketId);
    const pending = this.pendingApprovals.get(planId);

    if (!pending) {
      throw new Error(`No pending approval for ticket: ${ticketId}`);
    }

    logger.info("Manually rejecting ticket", { ticketId, reason });
    pending.resolve({ approved: false, rejectionReason: reason });
    this.pendingApprovals.delete(planId);
  }

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    const pending = this.pendingQuestionAnswers.get(questionId);

    if (!pending) {
      throw new Error(`No pending question: ${questionId}`);
    }

    logger.info("Answering question", { questionId });
    pending.resolve(answer);
    this.pendingQuestionAnswers.delete(questionId);

    await stateManager.removePendingQuestion(this.projectRoot, questionId);
  }

  getStatus(): { state: State; currentTicket?: Ticket } {
    if (!this.state) {
      throw new Error("Orchestrator not initialized");
    }

    const currentTicket = this.state.currentTicketId
      ? this.findTicket(this.state.currentTicketId)
      : undefined;

    return {
      state: { ...this.state },
      currentTicket: currentTicket ? { ...currentTicket } : undefined,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  async queueTicket(ticket: Ticket): Promise<void> {
    const validated = TicketSchema.parse(ticket);
    this.dynamicTickets.push(validated);
    logger.info("Ticket queued dynamically", { ticketId: validated.id });
  }

  getTickets(): Ticket[] {
    const fileTickets = this.ticketsFile?.tickets ?? [];
    return [...fileTickets, ...this.dynamicTickets];
  }

  // ===========================================================================
  // Private: Pacing Controls
  // ===========================================================================

  private resolvePacing(ticket: Ticket, config: Config): Pacing {
    const global = config.pacing ?? {};
    const perTicket = ticket.pacing ?? {};
    return { ...global, ...perTicket };
  }

  private async applyDelay(
    durationMs: number,
    reason: string,
    ticketId?: string,
  ): Promise<boolean> {
    if (!durationMs || durationMs <= 0) return true;

    logger.info("Pacing delay starting", {
      reason,
      durationMs: formatDuration(durationMs),
      ticketId,
    });
    this.emit("pacing:delay-start", reason, durationMs, ticketId);

    const result = await interruptibleDelay({
      durationMs,
      shouldInterrupt: () => this.pauseRequested || this.stopRequested,
      onTick: (elapsed, remaining) => {
        this.emit("pacing:delay-tick", reason, elapsed, remaining, ticketId);
      },
    });

    this.emit(
      "pacing:delay-end",
      reason,
      result.completed,
      result.elapsedMs,
      ticketId,
    );
    logger.info("Pacing delay ended", {
      reason,
      completed: result.completed,
      elapsedMs: result.elapsedMs,
      ticketId,
    });

    return result.completed;
  }

  private async handleRateLimitWithRetry(
    ticketId: string,
    config: Config,
    retryFn: () => Promise<{
      success: boolean;
      error?: string;
      sessionId?: string;
      costUsd?: number;
    }>,
  ): Promise<{
    success: boolean;
    error?: string;
    sessionId?: string;
    costUsd?: number;
  } | null> {
    const retryConfig = config.rateLimitRetry;
    if (!retryConfig.enabled) return null;

    const resetsAt = getLastRateLimitResetsAt();
    const waitResult = calculateRateLimitWait({
      resetsAt,
      maxWaitTimeMs: retryConfig.maxWaitTime,
      retryBufferMs: retryConfig.retryBuffer,
      fallbackDelayMs: retryConfig.fallbackDelay,
    });

    if (!waitResult.shouldWait) {
      logger.info("Rate limit retry skipped", {
        reason: waitResult.reason,
        ticketId,
      });
      return null;
    }

    logger.info("Rate limit retry: waiting for reset", {
      waitMs: waitResult.waitMs,
      reason: waitResult.reason,
      resetsAt,
      ticketId,
    });

    // Notify via multiplexer if configured
    if (retryConfig.notifyOnWait) {
      this.multiplexer
        .broadcastStatus({
          ticketId,
          ticketTitle: ticketId,
          status: "waiting",
          message: `Rate limit hit — waiting ${formatDuration(waitResult.waitMs)} for reset before retry`,
        })
        .catch((err) =>
          logger.warn("Failed to broadcast rate limit wait status", {
            error: String(err),
          }),
        );
    }

    // Wait using existing interruptible delay infrastructure
    const delayCompleted = await this.applyDelay(
      waitResult.waitMs,
      "rateLimitRetry",
      ticketId,
    );

    // Clear stale resetsAt
    clearRateLimitResetsAt();

    if (!delayCompleted) {
      logger.info("Rate limit wait interrupted", { ticketId });
      return null;
    }

    // Retry the operation
    logger.info("Rate limit retry: attempting after wait", { ticketId });
    return retryFn();
  }

  private async waitForStartAfter(
    startAfter: string | undefined,
    ticketId?: string,
  ): Promise<boolean> {
    if (!startAfter) return true;

    const targetTime = new Date(startAfter).getTime();
    const now = Date.now();
    const delayMs = targetTime - now;

    if (delayMs <= 0) return true;

    return this.applyDelay(delayMs, "startAfter", ticketId);
  }

  // ===========================================================================
  // Private: Queue Processing
  // ===========================================================================

  private async runQueue(): Promise<void> {
    if (!this.ticketsFile) {
      throw new Error("Tickets file not loaded");
    }

    const { config, hooks, tickets } = this.ticketsFile;

    // Execute beforeAll hooks
    await this.executeHooks(hooks, "beforeAll", {});

    // Global startAfter pacing check
    if (config.pacing?.startAfter) {
      const proceeded = await this.waitForStartAfter(config.pacing.startAfter);
      if (!proceeded) {
        logger.info("Pacing startAfter interrupted, pausing queue");
        this.pauseRequested = true;
        this.running = false;
        this.emit("queue:paused");
        return;
      }
    }

    // Process tickets in dependency order, re-evaluating after each completion
    let processable = this.getProcessableTickets(tickets);
    while (processable.length > 0) {
      const ticket = processable[0];
      if (this.pauseRequested || this.stopRequested) {
        logger.info("Processing paused/stopped");
        break;
      }

      if (this.memoryMonitor?.isAboveWarning()) {
        logger.warn(
          "Memory above warning threshold before processing next ticket, pausing queue",
        );
        break;
      }

      // Disk space check
      if (config.diskFloorMb > 0) {
        try {
          const disk = await getDiskSnapshot(this.projectRoot);
          if (disk.availableMb < config.diskFloorMb) {
            logger.warn("Disk space below floor, pausing queue", {
              availableMb: disk.availableMb.toFixed(0),
              floorMb: config.diskFloorMb,
            });
            break;
          }
        } catch (err) {
          logger.warn("Disk space check failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Per-ticket pacing checks
      const ticketPacing = this.resolvePacing(ticket, config);
      if (ticketPacing.startAfter) {
        const proceeded = await this.waitForStartAfter(
          ticketPacing.startAfter,
          ticket.id,
        );
        if (!proceeded) {
          logger.info("Per-ticket startAfter interrupted", {
            ticketId: ticket.id,
          });
          this.pauseRequested = true;
          break;
        }
      }

      try {
        await this.processTicket(ticket, config, hooks);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error("Ticket processing failed", {
          ticketId: ticket.id,
          error: error.message,
        });

        ticket.status = "failed";
        await this.saveTicketsFile();

        this.emit("ticket:failed", ticket, error.message);
        this.multiplexer
          .broadcastStatus({
            ticketId: ticket.id,
            ticketTitle: ticket.title,
            status: "failed",
            error: error.message,
          })
          .catch((err) =>
            logger.warn("Failed to broadcast status", { error: String(err) }),
          );
        this.emit("error", error);

        if (!config.continueOnError) {
          break;
        }
      }

      // Between-ticket cleanup (GC + session logs)
      await this.runBetweenTicketCleanup(config);

      // Re-evaluate processable tickets (dependencies may have been unblocked)
      processable = this.getProcessableTickets(tickets);

      // Delay between tickets (only if more tickets to process)
      if (processable.length > 0) {
        const postTicketPacing = this.resolvePacing(ticket, config);
        if (postTicketPacing.delayBetweenTickets) {
          const proceeded = await this.applyDelay(
            postTicketPacing.delayBetweenTickets,
            "delayBetweenTickets",
            ticket.id,
          );
          if (!proceeded) {
            logger.info("Delay between tickets interrupted", {
              ticketId: ticket.id,
            });
            this.pauseRequested = true;
            break;
          }
        }
      }
    }

    // Execute afterAll hooks if not stopped
    if (!this.stopRequested) {
      await this.executeHooks(hooks, "afterAll", {});
    }

    this.running = false;

    if (this.pauseRequested) {
      this.emit("queue:paused");
    } else {
      this.emit("queue:complete");
    }
  }

  private async runBetweenTicketCleanup(config: Config): Promise<void> {
    const preSnap = getMemorySnapshot();
    logger.info('Between-ticket cleanup: pre', { rssMb: preSnap.rssMb.toFixed(1) });

    const gcRan = tryGarbageCollect();
    if (gcRan) {
      logger.info('GC completed between tickets');
    }

    if (config.sessionCleanup.enabled) {
      try {
        const result = await cleanupSessionLogs({
          maxSizeMb: config.sessionCleanup.maxSizeMb,
          maxAgeDays: config.sessionCleanup.maxAgeDays,
        });
        if (result.deletedFiles > 0) {
          logger.info('Session logs cleaned between tickets', {
            deletedFiles: result.deletedFiles,
            freedMb: result.freedMb,
          });
        }
      } catch (err) {
        logger.warn('Session cleanup failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const postSnap = getMemorySnapshot();
    logger.info('Between-ticket cleanup: post', {
      rssMb: postSnap.rssMb.toFixed(1),
      deltaMb: (postSnap.rssMb - preSnap.rssMb).toFixed(1),
    });
  }

  private async resumeFromState(): Promise<void> {
    if (!this.state || !this.ticketsFile) {
      throw new Error("State or tickets file not loaded");
    }

    const { config, hooks } = this.ticketsFile;
    const ticket = this.findTicket(this.state.currentTicketId!);

    if (!ticket) {
      logger.warn("Current ticket not found, starting fresh");
      return this.runQueue();
    }

    logger.info("Resuming from phase", {
      ticketId: ticket.id,
      phase: this.state.currentPhase,
    });

    try {
      switch (this.state.currentPhase) {
        case "planning":
          await this.processTicket(ticket, config, hooks);
          break;

        case "awaiting_approval":
          await this.resumeFromApproval(ticket, config, hooks);
          break;

        case "executing":
          await this.resumeFromExecution(ticket, config, hooks);
          break;

        default:
          await this.runQueue();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);

      if (!config.continueOnError) {
        throw error;
      }
    }

    // Continue with remaining tickets
    await this.runQueue();
  }

  private async resumeFromApproval(
    ticket: Ticket,
    config: Config,
    hooks?: Hooks,
  ): Promise<void> {
    // Resolve ticket working directory
    const ticketCwd = ticket.cwd
      ? resolve(this.projectRoot, ticket.cwd)
      : this.projectRoot;

    const plan = await stateManager.loadPlan(this.projectRoot, ticket.id);

    if (!plan) {
      logger.warn("No saved plan found, regenerating");
      return this.processTicket(ticket, config, hooks);
    }

    const result = await this.waitForApproval(ticket, plan, config);

    if (result.approved) {
      await this.executeTicket(ticket, plan, config, hooks, [], [], ticketCwd);
    } else if (result.rejectionReason && config.maxPlanRevisions > 0) {
      // Rejection with feedback — enter revision loop
      await this.processTicket(ticket, config, hooks, result.rejectionReason);
    } else {
      ticket.status = "skipped";
      await this.saveTicketsFile();
      this.emit("ticket:skipped", ticket);
      this.multiplexer
        .broadcastStatus({
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          status: "skipped",
        })
        .catch((err) =>
          logger.warn("Failed to broadcast status", { error: String(err) }),
        );
    }
  }

  private async resumeFromExecution(
    ticket: Ticket,
    config: Config,
    hooks?: Hooks,
  ): Promise<void> {
    // Resolve ticket working directory
    const ticketCwd = ticket.cwd
      ? resolve(this.projectRoot, ticket.cwd)
      : this.projectRoot;

    const sessionId = await stateManager.loadSession(
      this.projectRoot,
      ticket.id,
    );

    // Check for loop state — route to loop execution if mid-loop
    const currentState = await stateManager.load(this.projectRoot);
    if (currentState.loopState && ticket.loop) {
      const plan = await stateManager.loadPlan(this.projectRoot, ticket.id);
      if (plan) {
        await this.executeLoopTicket(
          ticket,
          plan,
          config,
          hooks,
          [],
          [],
          ticketCwd,
        );
        return;
      }
    }

    if (!sessionId) {
      logger.warn("No saved session found, re-executing");
      const plan = await stateManager.loadPlan(this.projectRoot, ticket.id);
      if (plan) {
        await this.executeTicket(
          ticket,
          plan,
          config,
          hooks,
          [],
          [],
          ticketCwd,
        );
      } else {
        await this.processTicket(ticket, config, hooks);
      }
      return;
    }

    logger.info("Resuming Claude session", { ticketId: ticket.id, sessionId });

    await this.executeWithSession(
      ticket,
      sessionId,
      config,
      hooks,
      undefined,
      ticketCwd,
    );
  }

  // ===========================================================================
  // Private: Ticket Processing
  // ===========================================================================

  private async processTicket(
    ticket: Ticket,
    config: Config,
    globalHooks?: Hooks,
    initialFeedback?: string,
  ): Promise<void> {
    logger.setContext({ ticketId: ticket.id });
    logger.info("Processing ticket", { title: ticket.title });

    const mergedHooks = hookExecutor.mergeHooks(globalHooks, ticket.hooks);

    // Resolve ticket working directory (relative to project root or absolute)
    const ticketCwd = ticket.cwd
      ? resolve(this.projectRoot, ticket.cwd)
      : this.projectRoot;

    // Resolve images once for all prompt builders
    const { resolved: resolvedImagePaths, warnings: imageWarnings } = ticket
      .images?.length
      ? await resolveAndValidateImages(this.projectRoot, ticket.images)
      : { resolved: [] as string[], warnings: [] as string[] };

    this.emit("ticket:start", ticket);
    this.multiplexer
      .broadcastStatus({
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        status: "started",
        message: "Processing started",
      })
      .catch((err) =>
        logger.warn("Failed to broadcast status", { error: String(err) }),
      );

    // Execute beforeEach hooks
    await this.executeHooks(mergedHooks, "beforeEach", {
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      ticketStatus: ticket.status,
      cwd: ticketCwd,
    });

    // Resolve effective plan mode (ticket override > global config)
    const usePlanMode = ticket.planMode ?? config.planMode;

    if (usePlanMode) {
      let feedback: string | undefined = initialFeedback;
      let approved = false;
      const maxRevisions = config.maxPlanRevisions;

      for (let attempt = 0; attempt <= maxRevisions; attempt++) {
        // Phase: Planning
        await this.updateState({
          currentTicketId: ticket.id,
          currentPhase: "planning",
        });
        ticket.status = "planning";
        await this.saveTicketsFile();

        const plan = await this.generatePlan(
          ticket,
          config,
          ticketCwd,
          feedback,
          resolvedImagePaths,
          imageWarnings,
        );

        // Save plan
        const planPath = await stateManager.savePlan(
          this.projectRoot,
          ticket.id,
          plan,
        );

        // Execute onPlanGenerated hooks
        await this.executeHooks(mergedHooks, "onPlanGenerated", {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          plan,
          planPath,
          cwd: ticketCwd,
        });

        this.emit("ticket:plan-generated", ticket, plan);

        // Phase: Awaiting Approval
        await this.updateState({ currentPhase: "awaiting_approval" });
        ticket.status = "awaiting_approval";
        await this.saveTicketsFile();

        const result = await this.waitForApproval(ticket, plan, config);

        // Execute onApproval hooks with approval context
        await this.executeHooks(mergedHooks, "onApproval", {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          plan,
          approved: result.approved,
          rejectionReason: result.rejectionReason,
          cwd: ticketCwd,
        });

        if (result.approved) {
          approved = true;
          this.emit("ticket:approved", ticket);
          this.multiplexer
            .broadcastStatus({
              ticketId: ticket.id,
              ticketTitle: ticket.title,
              status: "started",
              message: "Plan approved, execution starting",
            })
            .catch((err) =>
              logger.warn("Failed to broadcast status", { error: String(err) }),
            );

          // Phase: Executing
          if (ticket.loop) {
            await this.executeLoopTicket(
              ticket,
              plan,
              config,
              mergedHooks,
              resolvedImagePaths,
              imageWarnings,
              ticketCwd,
            );
          } else {
            await this.executeTicket(
              ticket,
              plan,
              config,
              mergedHooks,
              resolvedImagePaths,
              imageWarnings,
              ticketCwd,
            );
          }
          break;
        }

        // Rejected
        this.emit("ticket:rejected", ticket, result.rejectionReason);

        if (!result.rejectionReason || attempt >= maxRevisions) {
          // No feedback or max revisions reached — skip
          break;
        }

        // Has feedback and revisions remaining — loop with feedback
        feedback = result.rejectionReason;
        logger.info("Plan rejected with feedback, revising", {
          attempt: attempt + 1,
          maxRevisions,
          feedback: feedback.slice(0, 100),
        });
      }

      if (!approved) {
        ticket.status = "skipped";
        await this.saveTicketsFile();
        await this.executeHooks(mergedHooks, "afterEach", {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          ticketStatus: "skipped",
          cwd: ticketCwd,
        });
        this.emit("ticket:skipped", ticket);
        this.multiplexer
          .broadcastStatus({
            ticketId: ticket.id,
            ticketTitle: ticket.title,
            status: "skipped",
          })
          .catch((err) =>
            logger.warn("Failed to broadcast status", { error: String(err) }),
          );
        logger.clearContext();
        return;
      }
    } else {
      // Direct execution mode — skip planning and approval
      logger.info("Plan mode disabled, executing directly");

      const directPrompt = this.buildDirectExecutionPrompt(
        ticket,
        resolvedImagePaths,
        imageWarnings,
      );
      if (ticket.loop) {
        await this.executeLoopTicket(
          ticket,
          directPrompt,
          config,
          mergedHooks,
          resolvedImagePaths,
          imageWarnings,
          ticketCwd,
        );
      } else {
        await this.executeTicket(
          ticket,
          directPrompt,
          config,
          mergedHooks,
          resolvedImagePaths,
          imageWarnings,
          ticketCwd,
        );
      }
    }

    // Execute afterEach hooks
    await this.executeHooks(mergedHooks, "afterEach", {
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      ticketStatus: ticket.status,
      cwd: ticketCwd,
    });

    logger.clearContext();
  }

  private async generatePlan(
    ticket: Ticket,
    config: Config,
    ticketCwd: string,
    feedback?: string,
    resolvedImagePaths: string[] = [],
    imageWarnings: string[] = [],
  ): Promise<string> {
    logger.info("Generating plan");

    const prompt = this.buildPlanPrompt(
      ticket,
      feedback,
      resolvedImagePaths,
      imageWarnings,
    );

    if (this.dryRun) {
      logger.info("Dry run: skipping actual plan generation");
      return `[DRY RUN] Plan for: ${ticket.title}\n\n${ticket.description}`;
    }

    // Store current model and fallback model
    const currentModel = config.model;
    const fallbackModel = config.fallbackModel;

    // First attempt with current model
    let result = await this.agent.generatePlan(
      prompt,
      {
        model: currentModel,
        timeout: config.timeouts.planGeneration,
        cwd: ticketCwd,
        verbose: this.verbose,
      },
      (text) => this.handleOutput(ticket, text),
    );

    // Check for rate limit and attempt fallback if applicable
    if (
      isRateLimitError({
        success: result.success,
        error: result.error,
        costUsd: result.costUsd,
        outputLength: result.plan?.length,
      }) &&
      shouldFallback(currentModel, fallbackModel)
    ) {
      logger.warn("Claude rate limit hit, retrying with fallback model", {
        ticketId: ticket.id,
        originalModel: currentModel || "CLI default",
        fallbackModel,
      });

      // Retry with fallback model
      result = await this.agent.generatePlan(
        prompt,
        {
          model: fallbackModel,
          timeout: config.timeouts.planGeneration,
          cwd: ticketCwd,
          verbose: this.verbose,
        },
        (text) => this.handleOutput(ticket, text),
      );
    }

    // If both primary and fallback hit rate limits, attempt wait-and-retry
    if (
      !result.success &&
      isRateLimitError({
        success: result.success,
        error: result.error,
        costUsd: result.costUsd,
        outputLength: result.plan?.length,
      }) &&
      config.rateLimitRetry.enabled
    ) {
      const resetsAt = getLastRateLimitResetsAt();
      const waitCalc = calculateRateLimitWait({
        resetsAt,
        maxWaitTimeMs: config.rateLimitRetry.maxWaitTime,
        retryBufferMs: config.rateLimitRetry.retryBuffer,
        fallbackDelayMs: config.rateLimitRetry.fallbackDelay,
      });

      if (waitCalc.shouldWait) {
        logger.info("Rate limit retry (plan): waiting for reset", {
          waitMs: waitCalc.waitMs,
          reason: waitCalc.reason,
          ticketId: ticket.id,
        });

        if (config.rateLimitRetry.notifyOnWait) {
          this.multiplexer
            .broadcastStatus({
              ticketId: ticket.id,
              ticketTitle: ticket.title,
              status: "waiting",
              message: `Rate limit hit during planning — waiting ${formatDuration(waitCalc.waitMs)} for reset`,
            })
            .catch((err) =>
              logger.warn("Failed to broadcast rate limit wait status", {
                error: String(err),
              }),
            );
        }

        const delayCompleted = await this.applyDelay(
          waitCalc.waitMs,
          "rateLimitRetry",
          ticket.id,
        );
        clearRateLimitResetsAt();

        if (delayCompleted) {
          result = await this.agent.generatePlan(
            prompt,
            {
              model: fallbackModel,
              timeout: config.timeouts.planGeneration,
              cwd: ticketCwd,
              verbose: this.verbose,
            },
            (text) => this.handleOutput(ticket, text),
          );
        }
      }
    }

    if (!result.success) {
      throw new Error(
        result.error ?? "Plan generation failed with unknown error",
      );
    }

    if (!result.plan) {
      logger.error("Plan generation returned empty plan", {
        success: result.success,
        costUsd: result.costUsd,
        errorField: result.error,
      });
      throw new Error(
        "Plan generation returned empty content — Claude may have produced no output",
      );
    }

    logger.info("Plan generated", { costUsd: result.costUsd });
    return result.plan;
  }

  private async waitForApproval(
    ticket: Ticket,
    plan: string,
    config: Config,
  ): Promise<ApprovalResult> {
    if (config.autoApprove) {
      logger.info("Auto-approving plan");
      return { approved: true };
    }

    logger.info("Waiting for approval");

    const planId = this.getPlanIdForTicket(ticket.id);

    return new Promise<ApprovalResult>((resolve, reject) => {
      this.pendingApprovals.set(planId, { resolve, reject });

      this.multiplexer
        .requestApproval({
          planId,
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          plan,
        })
        .then((response) => {
          if (this.pendingApprovals.has(planId)) {
            this.pendingApprovals.delete(planId);
            resolve({
              approved: response.approved,
              rejectionReason: response.rejectionReason,
            });
          }
        })
        .catch((err) => {
          this.pendingApprovals.delete(planId);
          reject(err);
        });
    });
  }

  private async executeTicket(
    ticket: Ticket,
    plan: string,
    config: Config,
    hooks?: Hooks,
    resolvedImagePaths: string[] = [],
    imageWarnings: string[] = [],
    ticketCwd?: string,
  ): Promise<void> {
    // Use provided ticketCwd or fall back to projectRoot
    const effectiveCwd = ticketCwd ?? this.projectRoot;
    await this.updateState({ currentPhase: "executing" });
    ticket.status = "executing";
    await this.saveTicketsFile();

    this.emit("ticket:executing", ticket);

    const prompt = this.buildExecutionPrompt(
      ticket,
      plan,
      resolvedImagePaths,
      imageWarnings,
    );

    if (this.dryRun) {
      logger.info("Dry run: skipping actual execution");
      ticket.status = "completed";
      await this.saveTicketsFile();
      await markTicketCompleteInFile(this.ticketsFilePath, ticket.id);
      this.emit("ticket:completed", ticket);
      this.multiplexer
        .broadcastStatus({
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          status: "completed",
        })
        .catch((err) =>
          logger.warn("Failed to broadcast status", { error: String(err) }),
        );
      return;
    }

    let retries = 0;
    const maxRetries = config.maxRetries;
    const isAutonomous =
      (ticket.planMode ?? config.planMode) === false || config.autoApprove;

    while (retries <= maxRetries) {
      try {
        const result = await this.agent.execute(
          prompt,
          {
            model: config.model,
            skipPermissions: isAutonomous || config.skipPermissions,
            timeout: config.timeouts.execution,
            cwd: effectiveCwd,
            verbose: this.verbose,
          },
          {
            onEvent: (event) => this.handleClaudeEvent(ticket, event),
            onQuestion: (q) => this.handleQuestion(ticket, q, config, hooks),
            onOutput: (text) => this.handleOutput(ticket, text),
          },
        );

        // Rate limit detection and automatic fallback
        if (
          isRateLimitError({
            success: result.success,
            error: result.error,
            costUsd: result.costUsd,
          }) &&
          shouldFallback(config.model, config.fallbackModel)
        ) {
          logger.warn(
            "Claude rate limit hit during execution, retrying with fallback",
            {
              ticketId: ticket.id,
              originalModel: config.model || "CLI default",
              fallbackModel: config.fallbackModel,
            },
          );

          // Retry with fallback model
          const fallbackResult = await this.agent.execute(
            prompt,
            {
              model: config.fallbackModel,
              skipPermissions: isAutonomous || config.skipPermissions,
              timeout: config.timeouts.execution,
              cwd: effectiveCwd,
              verbose: this.verbose,
            },
            {
              onEvent: (event) => this.handleClaudeEvent(ticket, event),
              onQuestion: (q) => this.handleQuestion(ticket, q, config, hooks),
              onOutput: (text) => this.handleOutput(ticket, text),
            },
          );

          // If fallback succeeds, complete the ticket and return
          if (fallbackResult.success) {
            if (fallbackResult.sessionId) {
              await stateManager.saveSession(
                this.projectRoot,
                ticket.id,
                fallbackResult.sessionId,
              );
              await this.updateState({ sessionId: fallbackResult.sessionId });
            }

            if (!this.suppressCompletion) {
              ticket.status = "completed";
              await this.saveTicketsFile();
              await markTicketCompleteInFile(this.ticketsFilePath, ticket.id);
              await this.executeHooks(hooks, "onComplete", {
                ticketId: ticket.id,
                ticketTitle: ticket.title,
                cwd: effectiveCwd,
              });
              this.emit("ticket:completed", ticket);
              this.multiplexer
                .broadcastStatus({
                  ticketId: ticket.id,
                  ticketTitle: ticket.title,
                  status: "completed",
                })
                .catch((err) =>
                  logger.warn("Failed to broadcast status", {
                    error: String(err),
                  }),
                );
            }
            return;
          }

          // If fallback also hit rate limit, attempt wait-and-retry
          if (
            isRateLimitError({
              success: fallbackResult.success,
              error: fallbackResult.error,
              costUsd: fallbackResult.costUsd,
            })
          ) {
            const retryResult = await this.handleRateLimitWithRetry(
              ticket.id,
              config,
              () =>
                this.agent.execute(
                  prompt,
                  {
                    model: config.fallbackModel,
                    skipPermissions: isAutonomous || config.skipPermissions,
                    timeout: config.timeouts.execution,
                    cwd: effectiveCwd,
                    verbose: this.verbose,
                  },
                  {
                    onEvent: (event) => this.handleClaudeEvent(ticket, event),
                    onQuestion: (q) =>
                      this.handleQuestion(ticket, q, config, hooks),
                    onOutput: (text) => this.handleOutput(ticket, text),
                  },
                ),
            );

            if (retryResult?.success) {
              if (retryResult.sessionId) {
                await stateManager.saveSession(
                  this.projectRoot,
                  ticket.id,
                  retryResult.sessionId,
                );
                await this.updateState({ sessionId: retryResult.sessionId });
              }
              if (!this.suppressCompletion) {
                ticket.status = "completed";
                await this.saveTicketsFile();
                await markTicketCompleteInFile(this.ticketsFilePath, ticket.id);
                await this.executeHooks(hooks, "onComplete", {
                  ticketId: ticket.id,
                  ticketTitle: ticket.title,
                  cwd: effectiveCwd,
                });
                this.emit("ticket:completed", ticket);
                this.multiplexer
                  .broadcastStatus({
                    ticketId: ticket.id,
                    ticketTitle: ticket.title,
                    status: "completed",
                  })
                  .catch((err) =>
                    logger.warn("Failed to broadcast status", {
                      error: String(err),
                    }),
                  );
              }
              return;
            }
          }

          // If fallback fails, throw error to trigger normal retry logic
          throw new Error(fallbackResult.error ?? "Fallback execution failed");
        }

        if (result.sessionId) {
          await stateManager.saveSession(
            this.projectRoot,
            ticket.id,
            result.sessionId,
          );
          await this.updateState({ sessionId: result.sessionId });
        }

        if (result.success) {
          if (!this.suppressCompletion) {
            ticket.status = "completed";
            await this.saveTicketsFile();
            await markTicketCompleteInFile(this.ticketsFilePath, ticket.id);
            await this.executeHooks(hooks, "onComplete", {
              ticketId: ticket.id,
              ticketTitle: ticket.title,
              cwd: effectiveCwd,
            });
            this.emit("ticket:completed", ticket);
            this.multiplexer
              .broadcastStatus({
                ticketId: ticket.id,
                ticketTitle: ticket.title,
                status: "completed",
              })
              .catch((err) =>
                logger.warn("Failed to broadcast status", {
                  error: String(err),
                }),
              );
          }
          return;
        }

        throw new Error(result.error ?? "Execution failed");
      } catch (err) {
        retries++;
        const error = err instanceof Error ? err : new Error(String(err));

        if (retries > maxRetries) {
          ticket.status = "failed";
          await this.saveTicketsFile();
          await this.executeHooks(hooks, "onError", {
            ticketId: ticket.id,
            ticketTitle: ticket.title,
            error: error.message,
            cwd: effectiveCwd,
          });
          throw error;
        }

        logger.warn("Execution failed, retrying", {
          attempt: retries,
          maxRetries,
          error: error.message,
        });

        // Delay between retries
        const retryPacing = this.resolvePacing(ticket, config);
        if (retryPacing.delayBetweenRetries) {
          const proceeded = await this.applyDelay(
            retryPacing.delayBetweenRetries,
            "delayBetweenRetries",
            ticket.id,
          );
          if (!proceeded) {
            logger.info("Delay between retries interrupted", {
              ticketId: ticket.id,
            });
            ticket.status = "failed";
            await this.saveTicketsFile();
            throw new Error("Retry delay interrupted by pause/stop");
          }
        }
      }
    }
  }

  private async executeWithSession(
    ticket: Ticket,
    sessionId: string,
    config: Config,
    hooks?: Hooks,
    resumePrompt?: string,
    ticketCwd?: string,
  ): Promise<void> {
    // Use provided ticketCwd or fall back to projectRoot
    const effectiveCwd = ticketCwd ?? this.projectRoot;
    const isAutonomous =
      (ticket.planMode ?? config.planMode) === false || config.autoApprove;
    const currentModel = config.model;
    const fallbackModel = config.fallbackModel;

    let result = await this.agent.resume(
      sessionId,
      resumePrompt ?? "Continue from where you left off.",
      {
        model: currentModel,
        skipPermissions: isAutonomous || config.skipPermissions,
        timeout: config.timeouts.execution,
        cwd: effectiveCwd,
        verbose: this.verbose,
      },
      {
        onEvent: (event) => this.handleClaudeEvent(ticket, event),
        onQuestion: (q) => this.handleQuestion(ticket, q, config, hooks),
        onOutput: (text) => this.handleOutput(ticket, text),
      },
    );

    // Check for rate limit and attempt fallback if applicable
    if (
      isRateLimitError({
        success: result.success,
        error: result.error,
        costUsd: result.costUsd,
      }) &&
      shouldFallback(currentModel, fallbackModel)
    ) {
      logger.warn("Rate limit hit on resume, retrying with fallback", {
        ticketId: ticket.id,
        sessionId,
        originalModel: currentModel || "CLI default",
        fallbackModel,
      });

      result = await this.agent.resume(
        sessionId,
        resumePrompt ?? "Continue from where you left off.",
        {
          model: fallbackModel,
          skipPermissions: isAutonomous || config.skipPermissions,
          timeout: config.timeouts.execution,
          cwd: effectiveCwd,
          verbose: this.verbose,
        },
        {
          onEvent: (event) => this.handleClaudeEvent(ticket, event),
          onQuestion: (q) => this.handleQuestion(ticket, q, config, hooks),
          onOutput: (text) => this.handleOutput(ticket, text),
        },
      );
    }

    // If both primary and fallback hit rate limits, attempt wait-and-retry
    if (
      !result.success &&
      isRateLimitError({
        success: result.success,
        error: result.error,
        costUsd: result.costUsd,
      }) &&
      config.rateLimitRetry.enabled
    ) {
      const resetsAt = getLastRateLimitResetsAt();
      const waitCalc = calculateRateLimitWait({
        resetsAt,
        maxWaitTimeMs: config.rateLimitRetry.maxWaitTime,
        retryBufferMs: config.rateLimitRetry.retryBuffer,
        fallbackDelayMs: config.rateLimitRetry.fallbackDelay,
      });

      if (waitCalc.shouldWait) {
        logger.info("Rate limit retry (session): waiting for reset", {
          waitMs: waitCalc.waitMs,
          reason: waitCalc.reason,
          ticketId: ticket.id,
        });

        if (config.rateLimitRetry.notifyOnWait) {
          this.multiplexer
            .broadcastStatus({
              ticketId: ticket.id,
              ticketTitle: ticket.title,
              status: "waiting",
              message: `Rate limit hit during session resume — waiting ${formatDuration(waitCalc.waitMs)} for reset`,
            })
            .catch((err) =>
              logger.warn("Failed to broadcast rate limit wait status", {
                error: String(err),
              }),
            );
        }

        const delayCompleted = await this.applyDelay(
          waitCalc.waitMs,
          "rateLimitRetry",
          ticket.id,
        );
        clearRateLimitResetsAt();

        if (delayCompleted) {
          result = await this.agent.resume(
            sessionId,
            resumePrompt ?? "Continue from where you left off.",
            {
              model: fallbackModel,
              skipPermissions: isAutonomous || config.skipPermissions,
              timeout: config.timeouts.execution,
              cwd: effectiveCwd,
              verbose: this.verbose,
            },
            {
              onEvent: (event) => this.handleClaudeEvent(ticket, event),
              onQuestion: (q) => this.handleQuestion(ticket, q, config, hooks),
              onOutput: (text) => this.handleOutput(ticket, text),
            },
          );
        }
      }
    }

    if (result.success) {
      if (!this.suppressCompletion) {
        ticket.status = "completed";
        await this.saveTicketsFile();
        await markTicketCompleteInFile(this.ticketsFilePath, ticket.id);
        await this.executeHooks(hooks, "onComplete", {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          cwd: effectiveCwd,
        });
        this.emit("ticket:completed", ticket);
        this.multiplexer
          .broadcastStatus({
            ticketId: ticket.id,
            ticketTitle: ticket.title,
            status: "completed",
          })
          .catch((err) =>
            logger.warn("Failed to broadcast status", { error: String(err) }),
          );
      }
    } else {
      throw new Error(result.error ?? "Session resume failed");
    }
  }

  private async executeLoopTicket(
    ticket: Ticket,
    plan: string,
    config: Config,
    hooks?: Hooks,
    resolvedImagePaths: string[] = [],
    imageWarnings: string[] = [],
    ticketCwd?: string,
  ): Promise<void> {
    // Use provided ticketCwd or fall back to projectRoot
    const effectiveCwd = ticketCwd ?? this.projectRoot;
    const loop = ticket.loop!;
    const maxIterations = loop.maxIterations;

    // Determine start iteration from persisted loopState
    const currentState = await stateManager.load(this.projectRoot);
    let startIteration = 0;
    if (currentState.loopState && currentState.currentTicketId === ticket.id) {
      startIteration = currentState.loopState.currentIteration;
      logger.info("Resuming loop from persisted state", {
        ticketId: ticket.id,
        startIteration,
        maxIterations,
      });
    }

    this.suppressCompletion = true;

    try {
      for (let i = startIteration; i < maxIterations; i++) {
        if (this.pauseRequested || this.stopRequested) {
          logger.info("Loop paused/stopped", {
            ticketId: ticket.id,
            iteration: i,
          });
          // Persist loopState for resume
          await stateManager.update(this.projectRoot, {
            loopState: {
              currentIteration: i,
              maxIterations,
              conditionMet: false,
            },
          });
          return;
        }

        // Persist loopState before each iteration
        await stateManager.update(this.projectRoot, {
          loopState: {
            currentIteration: i,
            maxIterations,
            conditionMet: false,
          },
        });

        this.emit("loop:iteration-start", ticket, i, maxIterations);
        await this.executeHooks(hooks, "onIterationStart", {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          iteration: i,
          maxIterations,
          cwd: effectiveCwd,
        });

        // Clean session logs between iterations if configured
        if (config.sessionCleanup.enabled) {
          try {
            const result = await cleanupSessionLogs({
              maxSizeMb: config.sessionCleanup.maxSizeMb,
              maxAgeDays: config.sessionCleanup.maxAgeDays,
            });
            if (result.deletedFiles > 0) {
              logger.info("Session logs cleaned", {
                deletedFiles: result.deletedFiles,
                freedMb: result.freedMb,
              });
            }
          } catch (err) {
            logger.warn("Session cleanup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        logger.info("Starting loop iteration", {
          ticketId: ticket.id,
          iteration: i,
          maxIterations,
        });

        if (i === 0) {
          // First iteration: use executeTicket to create a new session
          await this.executeTicket(
            ticket,
            plan,
            config,
            hooks,
            resolvedImagePaths,
            imageWarnings,
            effectiveCwd,
          );
        } else {
          // Subsequent iterations: resume existing session with iteration prompt
          const sessionId = await stateManager.loadSession(
            this.projectRoot,
            ticket.id,
          );
          if (!sessionId) {
            throw new Error(
              `No session found for loop iteration ${i} of ticket ${ticket.id}`,
            );
          }

          const iterationPrompt = this.buildIterationPrompt(
            ticket,
            i,
            maxIterations,
          );
          await this.executeWithSession(
            ticket,
            sessionId,
            config,
            hooks,
            iterationPrompt,
            effectiveCwd,
          );
        }

        // Evaluate condition after each iteration
        let conditionResult: ConditionResult;
        try {
          const claudeRunner = async (prompt: string) => {
            const result = await this.agent.runPrompt(prompt, {
              model: config.model,
              cwd: effectiveCwd,
              timeout: 300000,
              verbose: this.verbose,
            });
            return {
              success: result.success,
              output: result.output,
              error: result.error,
            };
          };

          conditionResult = await evaluateCondition(
            loop.condition,
            { ticketId: ticket.id, iteration: i, goal: loop.goal },
            {
              allowShellHooks: config.allowShellHooks,
              claudeRunner,
              cwd: effectiveCwd,
              timeout: config.timeouts.execution,
            },
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.emit("loop:condition-failed", ticket, i, error.message);
          logger.error("Loop condition evaluation failed", {
            ticketId: ticket.id,
            iteration: i,
            error: error.message,
          });
          // Treat evaluation failure as condition not met, continue loop
          conditionResult = { met: false, error: error.message };
        }

        this.emit("loop:iteration-complete", ticket, i, conditionResult.met);
        await this.executeHooks(hooks, "onIterationComplete", {
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          iteration: i,
          maxIterations,
          conditionMet: conditionResult.met,
          cwd: effectiveCwd,
        });

        if (conditionResult.met) {
          logger.info("Loop condition met", {
            ticketId: ticket.id,
            iteration: i,
          });
          break;
        }

        logger.info("Loop condition not met, continuing", {
          ticketId: ticket.id,
          iteration: i,
          maxIterations,
          conditionOutput: conditionResult.output?.slice(0, 200),
        });

        // Delay between loop iterations
        const iterPacing = this.resolvePacing(ticket, config);
        if (iterPacing.delayBetweenIterations) {
          const proceeded = await this.applyDelay(
            iterPacing.delayBetweenIterations,
            "delayBetweenIterations",
            ticket.id,
          );
          if (!proceeded) {
            logger.info("Delay between iterations interrupted", {
              ticketId: ticket.id,
            });
            break;
          }
        }
      }
    } finally {
      this.suppressCompletion = false;
    }

    // Mark ticket as completed after loop finishes
    ticket.status = "completed";
    await this.saveTicketsFile();
    await markTicketCompleteInFile(this.ticketsFilePath, ticket.id);
    await this.executeHooks(hooks, "onComplete", {
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      cwd: effectiveCwd,
    });
    this.emit("ticket:completed", ticket);
    this.multiplexer
      .broadcastStatus({
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        status: "completed",
      })
      .catch((err) =>
        logger.warn("Failed to broadcast status", { error: String(err) }),
      );

    // Clear loopState
    await stateManager.update(this.projectRoot, { loopState: null });
  }

  private buildIterationPrompt(
    ticket: Ticket,
    iteration: number,
    maxIterations: number,
  ): string {
    const loop = ticket.loop!;
    const parts = [
      `# Continue: ${ticket.title}`,
      ``,
      `This is iteration ${iteration + 1} of ${maxIterations}.`,
      ``,
      `## Goal`,
      loop.goal,
      ``,
      `## Completion Condition`,
      loop.condition.type === "shell"
        ? `Shell command: \`${loop.condition.command}\` (exit 0 = condition met)`
        : `Prompt evaluation: ${loop.condition.command}`,
      ``,
      `## Instructions`,
      `Continue working toward the goal. Review your prior progress in this session and make further progress.`,
      `Do not repeat work already done. Focus on what remains.`,
    ];
    return parts.join("\n");
  }

  // ===========================================================================
  // Private: Event Handlers
  // ===========================================================================

  private handleClaudeEvent(
    ticket: Ticket,
    event: { type: string; message?: string; toolName?: string },
  ): void {
    // Only log actionable events to reduce noise (assistant/user/system events are ~95% of volume)
    if (
      event.type === "tool_use" ||
      event.type === "tool_result" ||
      event.type === "error" ||
      event.type === "result"
    ) {
      logger.debug("Claude event", {
        type: event.type,
        toolName: event.toolName,
      });
    }
    const eventLine = `[${event.type}] ${event.message ?? ""}`;
    this.emit("ticket:output", ticket, eventLine);
    this.emit("ticket:event", ticket, {
      type: event.type,
      toolName: event.toolName,
      message: event.message,
    });
  }

  private async handleQuestion(
    ticket: Ticket,
    question: { id: string; text: string; options?: string[] },
    config: Config,
    hooks?: Hooks,
  ): Promise<string> {
    logger.info("Question from Claude", {
      question: question.text.slice(0, 100),
    });

    this.emit("question", ticket, question.text);

    // Execute onQuestion hooks for prompt hints
    const hookResults = await this.executeHooks(
      hooks,
      "onQuestion",
      {
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        question: question.text,
        questionId: question.id,
      },
      { passivePrompts: true },
    );

    // Check if any prompt hooks provide guidance
    const promptHints = hookResults
      .filter((r) => r.success && r.output)
      .map((r) => r.output!)
      .join("\n");

    // Auto-answer in autonomous mode (planMode disabled or autoApprove enabled)
    const usePlanMode = ticket.planMode ?? config.planMode;
    const isAutonomous = !usePlanMode || config.autoApprove;
    if (isAutonomous) {
      let autoAnswer: string;
      if (question.options && question.options.length > 0) {
        const recommended = question.options.find((o) =>
          o.toLowerCase().includes("(recommended)"),
        );
        autoAnswer = recommended ?? question.options[0];
      } else {
        autoAnswer = "use your best judgement";
      }

      logger.info("Auto-answering question (autonomous mode)", {
        ticketId: ticket.id,
        question: question.text.slice(0, 100),
        answer: autoAnswer,
        reason: !usePlanMode ? "planMode disabled" : "autoApprove enabled",
      });

      return promptHints
        ? `${autoAnswer}\n\nContext:\n${promptHints}`
        : autoAnswer;
    }

    // Save pending question to state
    const pendingQuestion: PendingQuestion = {
      id: question.id,
      ticketId: ticket.id,
      question: question.text,
      askedAt: new Date().toISOString(),
    };
    await stateManager.addPendingQuestion(this.projectRoot, pendingQuestion);

    // Ask via multiplexer
    return new Promise<string>((resolve, reject) => {
      this.pendingQuestionAnswers.set(question.id, { resolve, reject });

      const questionWithHints = promptHints
        ? `${question.text}\n\nHints:\n${promptHints}`
        : question.text;

      this.multiplexer
        .askQuestion({
          questionId: question.id,
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          question: questionWithHints,
          options: question.options?.map((o) => ({ label: o, value: o })),
        })
        .then((response) => {
          if (this.pendingQuestionAnswers.has(question.id)) {
            this.pendingQuestionAnswers.delete(question.id);
            stateManager
              .removePendingQuestion(this.projectRoot, question.id)
              .catch(() => {});
            resolve(response.answer);
          }
        })
        .catch((err) => {
          this.pendingQuestionAnswers.delete(question.id);
          reject(err);
        });
    });
  }

  private handleOutput(ticket: Ticket, text: string): void {
    this.emit("ticket:output", ticket, text);
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private async loadTicketsFile(): Promise<void> {
    logger.debug("Loading tickets file", { path: this.ticketsFilePath });

    const content = await readFile(this.ticketsFilePath, "utf-8");

    let parsed: unknown;
    if (this.ticketsFilePath.endsWith(".json")) {
      parsed = JSON.parse(content);
    } else {
      parsed = parseYaml(content);
    }

    this.ticketsFile = parseTicketsFile(parsed);

    // Validate dependencies
    const validation = validateTicketDependencies(this.ticketsFile.tickets);
    if (!validation.valid) {
      throw new Error(
        `Invalid ticket dependencies:\n${validation.errors.join("\n")}`,
      );
    }

    logger.info("Loaded tickets file", {
      ticketCount: this.ticketsFile.tickets.length,
    });
  }

  private async saveTicketsFile(): Promise<void> {
    // Note: This implementation writes back to the original file
    // In a production system, you might want to track state separately
    // For now, we only update status in the state file
    if (this.state && this.ticketsFile) {
      const currentTicket = this.ticketsFile.tickets.find(
        (t) => t.id === this.state?.currentTicketId,
      );
      if (currentTicket) {
        await stateManager.update(this.projectRoot, {
          currentTicketId: currentTicket.id,
        });
      }
    }
  }

  private async updateState(updates: Partial<State>): Promise<void> {
    this.state = await stateManager.update(this.projectRoot, updates);
  }

  private async executeHooks(
    hooks: Hooks | undefined,
    name: keyof Hooks,
    context: HookContext,
    options?: { passivePrompts?: boolean },
  ) {
    const allowShellHooks = this.ticketsFile?.config?.allowShellHooks ?? false;
    const config = this.ticketsFile?.config;

    // Build Claude runner for prompt hooks (unless passive mode for onQuestion)
    const claudeRunner = options?.passivePrompts
      ? undefined
      : async (prompt: string) => {
          const currentModel = config?.model;
          const fallbackModel = config?.fallbackModel ?? "sonnet";

          let result = await this.agent.runPrompt(prompt, {
            model: currentModel,
            cwd: this.projectRoot,
            timeout: 300000,
            skipPermissions: config?.skipPermissions,
            verbose: this.verbose,
          });

          // Check for rate limit and attempt fallback if applicable
          if (
            isRateLimitError({
              success: result.success,
              error: result.error,
              costUsd: result.costUsd,
              outputLength: result.output?.length,
            }) &&
            shouldFallback(currentModel, fallbackModel)
          ) {
            logger.warn("Rate limit hit in hook, retrying with fallback", {
              promptLength: prompt.slice(0, 100),
              originalModel: currentModel || "CLI default",
              fallbackModel,
            });

            result = await this.agent.runPrompt(prompt, {
              model: fallbackModel,
              cwd: this.projectRoot,
              timeout: 300000,
              skipPermissions: config?.skipPermissions,
              verbose: this.verbose,
            });
          }

          // If both primary and fallback hit rate limits, attempt wait-and-retry
          if (
            !result.success &&
            isRateLimitError({
              success: result.success,
              error: result.error,
              costUsd: result.costUsd,
              outputLength: result.output?.length,
            }) &&
            config?.rateLimitRetry?.enabled
          ) {
            const retryConfig = config.rateLimitRetry;
            const resetsAt = getLastRateLimitResetsAt();
            const waitCalc = calculateRateLimitWait({
              resetsAt,
              maxWaitTimeMs: retryConfig.maxWaitTime,
              retryBufferMs: retryConfig.retryBuffer,
              fallbackDelayMs: retryConfig.fallbackDelay,
            });

            if (waitCalc.shouldWait) {
              logger.info("Rate limit retry (hook): waiting for reset", {
                waitMs: waitCalc.waitMs,
                reason: waitCalc.reason,
              });

              if (retryConfig.notifyOnWait) {
                this.multiplexer
                  .broadcastStatus({
                    ticketId: context.ticketId ?? "hook",
                    ticketTitle: context.ticketTitle ?? "hook",
                    status: "waiting",
                    message: `Rate limit hit during hook — waiting ${formatDuration(waitCalc.waitMs)} for reset`,
                  })
                  .catch((err) =>
                    logger.warn("Failed to broadcast rate limit wait status", {
                      error: String(err),
                    }),
                  );
              }

              const delayCompleted = await this.applyDelay(
                waitCalc.waitMs,
                "rateLimitRetry",
                context.ticketId,
              );
              clearRateLimitResetsAt();

              if (delayCompleted) {
                result = await this.agent.runPrompt(prompt, {
                  model: fallbackModel,
                  cwd: this.projectRoot,
                  timeout: 300000,
                  skipPermissions: config?.skipPermissions,
                  verbose: this.verbose,
                });
              }
            }
          }

          return {
            success: result.success,
            output: result.output,
            error: result.error,
          };
        };

    return hookExecutor.executeNamed(hooks, name, context, {
      allowShellHooks,
      claudeRunner,
    });
  }

  private findTicket(ticketId: string): Ticket | undefined {
    return this.ticketsFile?.tickets.find((t) => t.id === ticketId);
  }

  private getProcessableTickets(tickets: Ticket[]): Ticket[] {
    const allTickets = [...tickets, ...this.dynamicTickets];
    const completed = new Set(
      allTickets
        .filter((t) => t.status === "completed" || t.complete)
        .map((t) => t.id),
    );
    const failed = new Set(
      allTickets.filter((t) => t.status === "failed").map((t) => t.id),
    );

    return allTickets.filter((ticket) => {
      // Skip completed tickets (persisted in YAML)
      if (ticket.complete) {
        return false;
      }

      if (ticket.status !== "pending") {
        return false;
      }

      // Check dependencies
      if (ticket.dependencies) {
        for (const depId of ticket.dependencies) {
          if (failed.has(depId)) {
            logger.info("Skipping ticket due to failed dependency", {
              ticketId: ticket.id,
              failedDep: depId,
            });
            return false;
          }
          if (!completed.has(depId)) {
            return false;
          }
        }
      }

      return true;
    });
  }

  private getPlanIdForTicket(ticketId: string): string {
    return `plan-${ticketId}-${randomBytes(4).toString("hex")}`;
  }

  private buildPlanPrompt(
    ticket: Ticket,
    feedback?: string,
    resolvedImagePaths: string[] = [],
    imageWarnings: string[] = [],
  ): string {
    const parts = [
      `# Task: ${ticket.title}`,
      "",
      "## Description",
      ticket.description,
    ];

    if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
      parts.push("", "## Acceptance Criteria");
      for (const criterion of ticket.acceptanceCriteria) {
        parts.push(`- ${criterion}`);
      }
    }

    const imageSection = buildImagePromptSection(
      resolvedImagePaths,
      imageWarnings,
    );
    if (imageSection) {
      parts.push("", imageSection);
    }

    if (feedback) {
      parts.push("", "## Previous Plan Feedback", feedback);
    }

    parts.push(
      "",
      "## Instructions",
      "Create a detailed implementation plan for this task.",
      "Include:",
      "- Files to create or modify",
      "- Step-by-step implementation approach",
      "- Testing strategy",
      "- Potential risks or considerations",
      "",
      "Do NOT implement yet - only plan.",
    );

    return parts.join("\n");
  }

  private buildDirectExecutionPrompt(
    ticket: Ticket,
    resolvedImagePaths: string[] = [],
    imageWarnings: string[] = [],
  ): string {
    const parts = [
      `# Task: ${ticket.title}`,
      "",
      "## Description",
      ticket.description,
    ];

    if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
      parts.push("", "## Acceptance Criteria");
      for (const criterion of ticket.acceptanceCriteria) {
        parts.push(`- [ ] ${criterion}`);
      }
    }

    const imageSection = buildImagePromptSection(
      resolvedImagePaths,
      imageWarnings,
    );
    if (imageSection) {
      parts.push("", imageSection);
    }

    return parts.join("\n");
  }

  private buildExecutionPrompt(
    ticket: Ticket,
    plan: string,
    resolvedImagePaths: string[] = [],
    imageWarnings: string[] = [],
  ): string {
    const parts = [
      `# Execute Task: ${ticket.title}`,
      "",
      "## Plan",
      plan,
      "",
      "## Instructions",
      "Execute the plan above step by step.",
      "Follow TDD: write tests first, then implement.",
      "Commit changes incrementally.",
    ];

    if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
      parts.push("", "## Acceptance Criteria (must all be met)");
      for (const criterion of ticket.acceptanceCriteria) {
        parts.push(`- [ ] ${criterion}`);
      }
    }

    const imageSection = buildImagePromptSection(
      resolvedImagePaths,
      imageWarnings,
    );
    if (imageSection) {
      parts.push("", imageSection);
    }

    return parts.join("\n");
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new OrchestratorImpl(options);
}
