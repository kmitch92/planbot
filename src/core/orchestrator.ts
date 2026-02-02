import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import {
  type TicketsFile,
  type Ticket,
  type State,
  type Config,
  type Hooks,
  type PendingQuestion,
  parseTicketsFile,
  validateTicketDependencies,
} from "./schemas.js";
import { stateManager } from "./state.js";
import { claude } from "./claude.js";
import { hookExecutor, type HookContext } from "./hooks.js";
import type { Multiplexer } from "../messaging/multiplexer.js";
import { logger } from "../utils/logger.js";

// =============================================================================
// Types and Interfaces
// =============================================================================

export interface OrchestratorOptions {
  projectRoot: string;
  ticketsFile: string;
  multiplexer: Multiplexer;
  dryRun?: boolean;
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
  question: [ticket: Ticket, question: string];
  "queue:start": [];
  "queue:complete": [];
  "queue:paused": [];
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
}

// =============================================================================
// Internal Types
// =============================================================================

interface PendingApprovalResolvers {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  reason?: string;
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

  private ticketsFile: TicketsFile | null = null;
  private state: State | null = null;
  private running = false;
  private pauseRequested = false;
  private stopRequested = false;

  private pendingApprovals = new Map<string, PendingApprovalResolvers>();
  private pendingQuestionAnswers = new Map<string, PendingQuestionResolvers>();

  constructor(options: OrchestratorOptions) {
    super();
    this.projectRoot = options.projectRoot;
    this.ticketsFilePath = options.ticketsFile;
    this.multiplexer = options.multiplexer;
    this.dryRun = options.dryRun ?? false;
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
      await this.loadTicketsFile();
      await stateManager.init(this.projectRoot);
      this.state = await stateManager.load(this.projectRoot);

      this.running = true;
      this.pauseRequested = false;
      this.stopRequested = false;

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
    this.stopRequested = true;
    this.pauseRequested = true;

    claude.abort();

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
  }

  async approveTicket(ticketId: string): Promise<void> {
    const planId = this.getPlanIdForTicket(ticketId);
    const pending = this.pendingApprovals.get(planId);

    if (!pending) {
      throw new Error(`No pending approval for ticket: ${ticketId}`);
    }

    logger.info("Manually approving ticket", { ticketId });
    pending.resolve(true);
    this.pendingApprovals.delete(planId);
  }

  async rejectTicket(ticketId: string, reason?: string): Promise<void> {
    const planId = this.getPlanIdForTicket(ticketId);
    const pending = this.pendingApprovals.get(planId);

    if (!pending) {
      throw new Error(`No pending approval for ticket: ${ticketId}`);
    }

    logger.info("Manually rejecting ticket", { ticketId, reason });
    pending.reason = reason;
    pending.resolve(false);
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

    // Process tickets in dependency order
    for (const ticket of this.getProcessableTickets(tickets)) {
      if (this.pauseRequested || this.stopRequested) {
        logger.info("Processing paused/stopped");
        break;
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
        this.emit("error", error);

        if (!config.continueOnError) {
          break;
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
    hooks?: Hooks
  ): Promise<void> {
    const plan = await stateManager.loadPlan(this.projectRoot, ticket.id);

    if (!plan) {
      logger.warn("No saved plan found, regenerating");
      return this.processTicket(ticket, config, hooks);
    }

    const approved = await this.waitForApproval(ticket, plan, config);

    if (approved) {
      await this.executeTicket(ticket, plan, config, hooks);
    } else {
      ticket.status = "skipped";
      await this.saveTicketsFile();
      this.emit("ticket:skipped", ticket);
    }
  }

  private async resumeFromExecution(
    ticket: Ticket,
    config: Config,
    hooks?: Hooks
  ): Promise<void> {
    const sessionId = await stateManager.loadSession(
      this.projectRoot,
      ticket.id
    );

    if (!sessionId) {
      logger.warn("No saved session found, re-executing");
      const plan = await stateManager.loadPlan(this.projectRoot, ticket.id);
      if (plan) {
        await this.executeTicket(ticket, plan, config, hooks);
      } else {
        await this.processTicket(ticket, config, hooks);
      }
      return;
    }

    logger.info("Resuming Claude session", { ticketId: ticket.id, sessionId });

    await this.executeWithSession(ticket, sessionId, config, hooks);
  }

  // ===========================================================================
  // Private: Ticket Processing
  // ===========================================================================

  private async processTicket(
    ticket: Ticket,
    config: Config,
    globalHooks?: Hooks
  ): Promise<void> {
    logger.setContext({ ticketId: ticket.id });
    logger.info("Processing ticket", { title: ticket.title });

    const mergedHooks = hookExecutor.mergeHooks(globalHooks, ticket.hooks);

    this.emit("ticket:start", ticket);

    // Execute beforeEach hooks
    await this.executeHooks(mergedHooks, "beforeEach", {
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      ticketStatus: ticket.status,
    });

    // Phase: Planning
    await this.updateState({ currentTicketId: ticket.id, currentPhase: "planning" });
    ticket.status = "planning";
    await this.saveTicketsFile();

    const plan = await this.generatePlan(ticket, config);

    // Save plan
    const planPath = await stateManager.savePlan(this.projectRoot, ticket.id, plan);

    // Execute onPlanGenerated hooks
    await this.executeHooks(mergedHooks, "onPlanGenerated", {
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      plan,
      planPath,
    });

    this.emit("ticket:plan-generated", ticket, plan);

    // Phase: Awaiting Approval
    await this.updateState({ currentPhase: "awaiting_approval" });
    ticket.status = "awaiting_approval";
    await this.saveTicketsFile();

    const approved = await this.waitForApproval(ticket, plan, config);

    // Execute onApproval hooks
    await this.executeHooks(mergedHooks, "onApproval", {
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      plan,
    });

    if (!approved) {
      ticket.status = "skipped";
      await this.saveTicketsFile();
      await this.executeHooks(mergedHooks, "afterEach", {
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        ticketStatus: "skipped",
      });
      this.emit("ticket:skipped", ticket);
      logger.clearContext();
      return;
    }

    this.emit("ticket:approved", ticket);

    // Phase: Executing
    await this.executeTicket(ticket, plan, config, mergedHooks);

    // Execute afterEach hooks
    await this.executeHooks(mergedHooks, "afterEach", {
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      ticketStatus: ticket.status,
    });

    logger.clearContext();
  }

  private async generatePlan(ticket: Ticket, config: Config): Promise<string> {
    logger.info("Generating plan");

    const prompt = this.buildPlanPrompt(ticket);

    if (this.dryRun) {
      logger.info("Dry run: skipping actual plan generation");
      return `[DRY RUN] Plan for: ${ticket.title}\n\n${ticket.description}`;
    }

    const result = await claude.generatePlan(prompt, {
      model: config.model,
      timeout: config.timeouts.planGeneration,
      cwd: this.projectRoot,
    });

    if (!result.success || !result.plan) {
      throw new Error(result.error ?? "Plan generation failed");
    }

    logger.info("Plan generated", { costUsd: result.costUsd });
    return result.plan;
  }

  private async waitForApproval(
    ticket: Ticket,
    plan: string,
    config: Config
  ): Promise<boolean> {
    if (config.autoApprove) {
      logger.info("Auto-approving plan");
      return true;
    }

    logger.info("Waiting for approval");

    const planId = this.getPlanIdForTicket(ticket.id);

    return new Promise<boolean>((resolve, reject) => {
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

            if (!response.approved) {
              const pending = this.pendingApprovals.get(planId);
              this.emit("ticket:rejected", ticket, pending?.reason ?? response.rejectionReason);
            }

            resolve(response.approved);
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
    hooks?: Hooks
  ): Promise<void> {
    await this.updateState({ currentPhase: "executing" });
    ticket.status = "executing";
    await this.saveTicketsFile();

    this.emit("ticket:executing", ticket);

    const prompt = this.buildExecutionPrompt(ticket, plan);

    if (this.dryRun) {
      logger.info("Dry run: skipping actual execution");
      ticket.status = "completed";
      await this.saveTicketsFile();
      this.emit("ticket:completed", ticket);
      return;
    }

    let retries = 0;
    const maxRetries = config.maxRetries;

    while (retries <= maxRetries) {
      try {
        const result = await claude.execute(
          prompt,
          {
            model: config.model,
            skipPermissions: config.skipPermissions,
            timeout: config.timeouts.execution,
            cwd: this.projectRoot,
          },
          {
            onEvent: (event) => this.handleClaudeEvent(ticket, event),
            onQuestion: (q) => this.handleQuestion(ticket, q, config, hooks),
            onOutput: (text) => this.handleOutput(ticket, text),
          }
        );

        if (result.sessionId) {
          await stateManager.saveSession(this.projectRoot, ticket.id, result.sessionId);
          await this.updateState({ sessionId: result.sessionId });
        }

        if (result.success) {
          ticket.status = "completed";
          await this.saveTicketsFile();
          await this.executeHooks(hooks, "onComplete", {
            ticketId: ticket.id,
            ticketTitle: ticket.title,
          });
          this.emit("ticket:completed", ticket);
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
          });
          throw error;
        }

        logger.warn("Execution failed, retrying", {
          attempt: retries,
          maxRetries,
          error: error.message,
        });
      }
    }
  }

  private async executeWithSession(
    ticket: Ticket,
    sessionId: string,
    config: Config,
    hooks?: Hooks
  ): Promise<void> {
    const result = await claude.resume(
      sessionId,
      "Continue from where you left off.",
      {
        model: config.model,
        skipPermissions: config.skipPermissions,
        timeout: config.timeouts.execution,
        cwd: this.projectRoot,
      },
      {
        onEvent: (event) => this.handleClaudeEvent(ticket, event),
        onQuestion: (q) => this.handleQuestion(ticket, q, config, hooks),
        onOutput: (text) => this.handleOutput(ticket, text),
      }
    );

    if (result.success) {
      ticket.status = "completed";
      await this.saveTicketsFile();
      await this.executeHooks(hooks, "onComplete", {
        ticketId: ticket.id,
        ticketTitle: ticket.title,
      });
      this.emit("ticket:completed", ticket);
    } else {
      throw new Error(result.error ?? "Session resume failed");
    }
  }

  // ===========================================================================
  // Private: Event Handlers
  // ===========================================================================

  private handleClaudeEvent(ticket: Ticket, event: { type: string; message?: string }): void {
    logger.debug("Claude event", { type: event.type });
    stateManager.appendLog(
      this.projectRoot,
      ticket.id,
      `[${event.type}] ${event.message ?? ""}`
    ).catch((err) => {
      logger.warn("Failed to append log", { error: String(err) });
    });
  }

  private async handleQuestion(
    ticket: Ticket,
    question: { id: string; text: string; options?: string[] },
    config: Config,
    hooks?: Hooks
  ): Promise<string> {
    logger.info("Question from Claude", { question: question.text.slice(0, 100) });

    this.emit("question", ticket, question.text);

    // Execute onQuestion hooks for prompt hints
    const hookResults = await this.executeHooks(hooks, "onQuestion", {
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      question: question.text,
      questionId: question.id,
    });

    // Check if any prompt hooks provide guidance
    const promptHints = hookResults
      .filter((r) => r.success && r.output)
      .map((r) => r.output!)
      .join("\n");

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
    stateManager.appendLog(this.projectRoot, ticket.id, text).catch((err) => {
      logger.warn("Failed to append output log", { error: String(err) });
    });
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
      throw new Error(`Invalid ticket dependencies:\n${validation.errors.join("\n")}`);
    }

    logger.info("Loaded tickets file", { ticketCount: this.ticketsFile.tickets.length });
  }

  private async saveTicketsFile(): Promise<void> {
    // Note: This implementation writes back to the original file
    // In a production system, you might want to track state separately
    // For now, we only update status in the state file
    if (this.state && this.ticketsFile) {
      const currentTicket = this.ticketsFile.tickets.find(
        (t) => t.id === this.state?.currentTicketId
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
    context: HookContext
  ) {
    return hookExecutor.executeNamed(hooks, name, context);
  }

  private findTicket(ticketId: string): Ticket | undefined {
    return this.ticketsFile?.tickets.find((t) => t.id === ticketId);
  }

  private getProcessableTickets(tickets: Ticket[]): Ticket[] {
    const completed = new Set(
      tickets.filter((t) => t.status === "completed").map((t) => t.id)
    );
    const failed = new Set(
      tickets.filter((t) => t.status === "failed").map((t) => t.id)
    );

    return tickets.filter((ticket) => {
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

  private buildPlanPrompt(ticket: Ticket): string {
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
      "Do NOT implement yet - only plan."
    );

    return parts.join("\n");
  }

  private buildExecutionPrompt(ticket: Ticket, plan: string): string {
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

    return parts.join("\n");
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new OrchestratorImpl(options);
}
