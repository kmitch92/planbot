import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";

import { createOrchestrator } from "../orchestrator.js";
import type {
  AgentProvider,
  AgentOptions,
  ExecutionCallbacks,
  ExecutionResult,
  PlanResult,
  StreamEvent,
} from "../agent-provider.js";
import type { Multiplexer } from "../../messaging/multiplexer.js";

// =============================================================================
// Module Mocks
// =============================================================================
//
// The verify-loop test file uses `loadSession: vi.fn().mockResolvedValue("session-main-1")`
// so the existing verify-loop integration can find a session to resume against.
// We need the same pattern here so generateDebrief (called by orchestrator) can
// locate the session id to pass to provider.resume().
//
// For the handover/debrief flow, the orchestrator will call:
//   sessionId = await stateManager.loadSession(projectRoot, ticket.id)
// Per-test we override this mock when we need ticket-specific session ids.

vi.mock("../state.js", async () => {
  const actual = await vi.importActual<typeof import("../state.js")>(
    "../state.js",
  );
  return {
    // Re-export the real getDebriefPath helper so generateDebrief still works.
    getDebriefPath: actual.getDebriefPath,
    stateManager: {
      init: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue({
        version: "1.0.0",
        currentTicketId: null,
        currentPhase: "idle",
        sessionId: null,
        pauseRequested: false,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        pendingQuestions: [],
      }),
      save: vi.fn().mockResolvedValue(undefined),
      update: vi
        .fn()
        .mockImplementation(
          (_path: string, updates: Record<string, unknown>) =>
            Promise.resolve({
              version: "1.0.0",
              currentTicketId: null,
              currentPhase: "idle",
              sessionId: null,
              pauseRequested: false,
              startedAt: new Date().toISOString(),
              lastUpdatedAt: new Date().toISOString(),
              pendingQuestions: [],
              ...updates,
            }),
        ),
      savePlan: vi.fn().mockResolvedValue("/mock/plan/path.md"),
      loadPlan: vi.fn().mockResolvedValue(null),
      saveSession: vi.fn().mockResolvedValue(undefined),
      loadSession: vi.fn().mockResolvedValue("session-default"),
      addPendingQuestion: vi.fn().mockResolvedValue(undefined),
      removePendingQuestion: vi.fn().mockResolvedValue(undefined),
      getPaths: (root: string) => actual.stateManager.getPaths(root),
    },
  };
});

vi.mock("../claude.js", () => ({
  claude: {
    id: "claude-code",
    generatePlan: vi.fn().mockResolvedValue({
      success: true,
      plan: "Default plan",
      costUsd: 0,
    }),
    execute: vi.fn().mockResolvedValue({
      success: true,
      sessionId: "session-default",
    }),
    resume: vi.fn().mockResolvedValue({ success: true }),
    runPrompt: vi.fn().mockResolvedValue({ success: true, output: "" }),
    answerQuestion: vi.fn(),
    abort: vi.fn(),
  },
  getLastRateLimitResetsAt: vi.fn().mockReturnValue(null),
  clearRateLimitResetsAt: vi.fn(),
}));

vi.mock("../../utils/memory-monitor.js", () => ({
  createMemoryMonitor: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    isAboveWarning: vi.fn().mockReturnValue(false),
    isAboveCeiling: vi.fn().mockReturnValue(false),
    getLatest: vi.fn().mockReturnValue(null),
  })),
  getMemorySnapshot: vi.fn(() => ({
    rssMb: 100,
    heapUsedMb: 50,
    heapTotalMb: 200,
    externalMb: 10,
    openFds: 20,
    systemAvailableMb: 4000,
    childRssMb: 0,
    timestamp: new Date().toISOString(),
  })),
  getDiskSnapshot: vi.fn().mockResolvedValue({
    totalMb: 100000,
    availableMb: 50000,
    usedPercent: 50,
  }),
  tryGarbageCollect: vi.fn().mockReturnValue(false),
  formatSnapshotMeta: vi.fn(() => ({})),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setContext: vi.fn(),
    clearContext: vi.fn(),
  },
}));

vi.mock("../tickets-io.js", () => ({
  markTicketCompleteInFile: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createMockMultiplexer(): Multiplexer {
  return {
    addProvider: vi.fn(),
    removeProvider: vi.fn(),
    connectAll: vi.fn().mockResolvedValue(undefined),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
    requestApproval: vi.fn().mockResolvedValue({ approved: true }),
    askQuestion: vi.fn().mockResolvedValue({ answer: "mock answer" }),
    broadcastStatus: vi.fn().mockResolvedValue(undefined),
    cancelApproval: vi.fn(),
    cancelQuestion: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    emit: vi.fn().mockReturnValue(true),
    addListener: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listeners: vi.fn().mockReturnValue([]),
    rawListeners: vi.fn().mockReturnValue([]),
    listenerCount: vi.fn().mockReturnValue(0),
    prependListener: vi.fn().mockReturnThis(),
    prependOnceListener: vi.fn().mockReturnThis(),
    eventNames: vi.fn().mockReturnValue([]),
    setMaxListeners: vi.fn().mockReturnThis(),
    getMaxListeners: vi.fn().mockReturnValue(10),
  } as unknown as Multiplexer;
}

type VerifyOutcome = "PASS" | "FAIL" | "PARTIAL";

interface MockAgentProvider extends AgentProvider {
  generatePlan: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  runPrompt: ReturnType<typeof vi.fn>;
  answerQuestion: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

// Same heuristic used in orchestrator-verify-loop.test.ts.
function isVerifyPrompt(prompt: string): boolean {
  return (
    prompt.includes("VERIFY_START") || prompt.includes("verification agent")
  );
}

function emitVerifyTokens(
  ticketId: string,
  outcome: VerifyOutcome,
  callbacks: ExecutionCallbacks,
): void {
  const lines: string[] = [];
  lines.push(`[VERIFY_START ticketId="${ticketId}"]`);

  if (outcome === "PASS") {
    lines.push(`[CRITERION index=0 status="PASS" reason="ok"]`);
    lines.push(`[VERIFY_END ticketId="${ticketId}" result="PASS"]`);
  } else if (outcome === "FAIL") {
    lines.push(
      `[CRITERION index=0 status="FAIL" reason="placeholder code remains"]`,
    );
    lines.push(`[VERIFY_END ticketId="${ticketId}" result="FAIL"]`);
  } else {
    lines.push(`[CRITERION index=0 status="PASS" reason="ok"]`);
    lines.push(
      `[CRITERION index=1 status="FAIL" reason="missing edge case"]`,
    );
    lines.push(`[VERIFY_END ticketId="${ticketId}" result="PARTIAL"]`);
  }

  lines.push(`[VERIFY_COMPLETE summary="0/1 passed"]`);

  callbacks.onEvent?.({ type: "assistant", message: lines.join("\n") + "\n" });
}

function extractVerifyTicketId(prompt: string): string | null {
  const match = /### Ticket:\s*(\S+)/.exec(prompt);
  return match ? match[1] ?? null : null;
}

interface MockAgentConfig {
  /** Map of ticket id → debrief markdown the resume call should emit. */
  debriefs?: Record<string, string>;
  /** Per-ticket id → result of resume (defaults to success). */
  resumeResults?: Record<string, { success: boolean; error?: string }>;
  /** Queue of verify outcomes (only used when verifyRetries > 0). */
  verifyOutcomes?: VerifyOutcome[];
  /** Per-ticket session id returned by execute. */
  ticketSessionIds?: Record<string, string>;
}

/**
 * Build a mock provider that:
 *   - On execute: extracts the ticket id from the prompt header (first
 *     "# Task:" / "# Execute Task:" line), records the captured prompt, then
 *     returns a per-ticket session id (or "session-<ticketId>" by default).
 *   - On resume: looks up the debrief markdown for the current call and emits
 *     it as an assistant event, then returns the configured success/failure.
 *
 * The orchestrator's verify-loop also uses execute (verify prompt) and resume
 * (verify-retry feedback). The mock distinguishes verify prompts via
 * isVerifyPrompt() so verify and debrief callsites do not collide.
 */
function createMockAgent(config: MockAgentConfig = {}): MockAgentProvider {
  const debriefs = config.debriefs ?? {};
  const resumeResults = config.resumeResults ?? {};
  const verifyQueue = [...(config.verifyOutcomes ?? [])];
  const sessionIds = config.ticketSessionIds ?? {};

  // The orchestrator processes tickets in YAML order, and ticketSessionIds is
  // declared per-ticket in that same order. Each main execute() call therefore
  // corresponds to the next ticket id in this queue.
  const mainTicketQueue = [...Object.keys(sessionIds)];
  let mainCallIndex = 0;

  /** Order-of-call tracking: each entry records what kind of call it was. */
  const callLog: Array<
    | { kind: "execute-main"; ticketId: string; prompt: string }
    | { kind: "execute-verify"; ticketId: string; prompt: string }
    | { kind: "resume-debrief"; ticketId: string; sessionId: string }
    | { kind: "resume-verify-feedback"; sessionId: string; input: string }
  > = [];

  function nextMainTicketId(): string {
    const id = mainTicketQueue[mainCallIndex] ?? `unknown-${mainCallIndex}`;
    mainCallIndex += 1;
    return id;
  }

  const generatePlan = vi.fn(
    async (): Promise<PlanResult> => ({
      success: true,
      plan: "Mocked plan",
      costUsd: 0,
    }),
  );

  const execute = vi.fn(
    async (
      prompt: string,
      _options: AgentOptions,
      callbacks: ExecutionCallbacks,
    ): Promise<ExecutionResult> => {
      if (isVerifyPrompt(prompt)) {
        const ticketId = extractVerifyTicketId(prompt) ?? "unknown";
        callLog.push({ kind: "execute-verify", ticketId, prompt });
        const outcome = verifyQueue.shift() ?? "PASS";
        emitVerifyTokens(ticketId, outcome, callbacks);
        return { success: true };
      }

      // Main ticket execution — identify by call order against the queue.
      const ticketId = nextMainTicketId();
      callLog.push({ kind: "execute-main", ticketId, prompt });

      callbacks.onEvent?.({
        type: "assistant",
        message: "Working on ticket...",
      });

      const sessionId = sessionIds[ticketId] ?? `session-${ticketId}`;
      return { success: true, sessionId };
    },
  );

  const resume = vi.fn(
    async (
      sessionId: string,
      input: string,
      _options: AgentOptions,
      callbacks: ExecutionCallbacks,
    ): Promise<ExecutionResult> => {
      // Determine whether this resume is for a debrief or for a verify-retry.
      // Debrief prompts begin with "# Handover debrief for ticket".
      if (input.startsWith("# Handover debrief for ticket")) {
        // Identify ticket id from session id (mapped backwards from sessionIds)
        // or from the prompt body (`# Handover debrief for ticket \`<id>\``).
        const match = /# Handover debrief for ticket\s+`([^`]+)`/.exec(input);
        const ticketId = match?.[1] ?? "unknown";

        callLog.push({ kind: "resume-debrief", ticketId, sessionId });

        const explicitResult = resumeResults[ticketId];
        if (explicitResult && explicitResult.success === false) {
          return {
            success: false,
            error: explicitResult.error ?? "agent failed",
          };
        }

        const debriefBody =
          debriefs[ticketId] ??
          `# Debrief: ${ticketId}\n\n## Files modified\n- src/foo.ts\n\n## Decisions\nChose X over Y because...\n`;

        callbacks.onEvent?.({ type: "assistant", message: debriefBody });
        return { success: true };
      }

      // Otherwise: verify-retry feedback
      callLog.push({ kind: "resume-verify-feedback", sessionId, input });
      callbacks.onEvent?.({
        type: "assistant",
        message: "Resumed and addressed feedback.",
      });
      return { success: true, sessionId };
    },
  );

  const runPrompt = vi.fn(async () => ({ success: true, output: "" }));
  const answerQuestion = vi.fn();
  const abort = vi.fn();

  const agent = {
    id: "mock-agent",
    generatePlan,
    execute,
    resume,
    runPrompt,
    answerQuestion,
    abort,
  } as unknown as MockAgentProvider;

  // Attach call log so tests can inspect ordering and shape.
  (agent as unknown as { _callLog: typeof callLog })._callLog = callLog;

  return agent;
}

function getCallLog(agent: MockAgentProvider) {
  return (agent as unknown as {
    _callLog: Array<
      | { kind: "execute-main"; ticketId: string; prompt: string }
      | { kind: "execute-verify"; ticketId: string; prompt: string }
      | { kind: "resume-debrief"; ticketId: string; sessionId: string }
      | { kind: "resume-verify-feedback"; sessionId: string; input: string }
    >;
  })._callLog;
}

function debriefPath(projectRoot: string, ticketId: string): string {
  return join(projectRoot, ".planbot", "debriefs", `${ticketId}.md`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function countMainExecutes(agent: MockAgentProvider, ticketId?: string): number {
  return getCallLog(agent).filter(
    (entry) =>
      entry.kind === "execute-main" &&
      (ticketId ? entry.ticketId === ticketId : true),
  ).length;
}

function countDebriefResumes(
  agent: MockAgentProvider,
  ticketId?: string,
): number {
  return getCallLog(agent).filter(
    (entry) =>
      entry.kind === "resume-debrief" &&
      (ticketId ? entry.ticketId === ticketId : true),
  ).length;
}

// =============================================================================
// Test Suite
// =============================================================================

describe("Orchestrator Handover Integration", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-handover-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Group A — Handover write (debrief generation)
  // ---------------------------------------------------------------------------

  it("does not generate a debrief when handoverEnabled is false (default)", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description for ticket-1
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countMainExecutes(agent, "ticket-1")).toBe(1);
    expect(countDebriefResumes(agent)).toBe(0);
    expect(await fileExists(debriefPath(testDir, "ticket-1"))).toBe(false);

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
  });

  it("generates and writes a debrief when handoverEnabled is true at config level", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const debriefMarkdown =
      "# Debrief: ticket-1\n\n## Files modified\n- src/foo.ts\n\n## Decisions\nChose X over Y because...\n";

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
      debriefs: { "ticket-1": debriefMarkdown },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countDebriefResumes(agent, "ticket-1")).toBe(1);

    const debriefEntry = getCallLog(agent).find(
      (e) => e.kind === "resume-debrief",
    );
    expect(debriefEntry).toBeDefined();
    if (debriefEntry?.kind === "resume-debrief") {
      expect(debriefEntry.sessionId).toBe("session-ticket-1");
    }

    const writtenPath = debriefPath(testDir, "ticket-1");
    expect(await fileExists(writtenPath)).toBe(true);
    const written = await readFile(writtenPath, "utf8");
    expect(written).toBe(debriefMarkdown);
  });

  it("ticket-level handoverEnabled true overrides config false", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: false
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
    handoverEnabled: true
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countDebriefResumes(agent, "ticket-1")).toBe(1);
    expect(await fileExists(debriefPath(testDir, "ticket-1"))).toBe(true);
  });

  it("ticket-level handoverEnabled false overrides config true", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
    handoverEnabled: false
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countDebriefResumes(agent, "ticket-1")).toBe(0);
    expect(await fileExists(debriefPath(testDir, "ticket-1"))).toBe(false);
  });

  it("does not fail the ticket when debrief generation fails", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
      resumeResults: { "ticket-1": { success: false, error: "rate limit" } },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
    expect(await fileExists(debriefPath(testDir, "ticket-1"))).toBe(false);

    const { logger } = await import("../../utils/logger.js");
    const warnCalls = vi.mocked(logger.warn).mock.calls.map(
      (c) => String(c[0] ?? ""),
    );
    expect(
      warnCalls.some((msg) => msg.includes("handover:error")),
      `expected logger.warn to be called with a message containing "handover:error". Captured: ${JSON.stringify(warnCalls)}`,
    ).toBe(true);
  });

  it("does not attempt debrief when the ticket itself fails", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
  maxRetries: 0
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
    });

    // Force execute() to fail for the main ticket so the orchestrator marks
    // the ticket failed and should not attempt a debrief.
    //
    // NOTE: costUsd is set above the rate-limit-detection heuristic threshold
    // (>=0.01) so the orchestrator does NOT trigger automatic fallback retry,
    // which would otherwise succeed and mark the ticket completed.
    agent.execute.mockImplementation(
      async (
        prompt: string,
        _opts: AgentOptions,
        _callbacks: ExecutionCallbacks,
      ): Promise<ExecutionResult> => {
        getCallLog(agent).push({
          kind: "execute-main",
          ticketId: "ticket-1",
          prompt,
        });
        return {
          success: false,
          error: "Connection timeout during main execution",
          costUsd: 0.5,
        };
      },
    );

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });
    // Suppress unhandled 'error' emissions from the orchestrator — we
    // intentionally provoke a ticket failure for this test.
    orchestrator.on("error", () => {});

    await orchestrator.start();

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("failed");
    expect(countDebriefResumes(agent, "ticket-1")).toBe(0);
    expect(await fileExists(debriefPath(testDir, "ticket-1"))).toBe(false);
  });

  it("logs structured handover events through the lifecycle", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const { logger } = await import("../../utils/logger.js");
    const infoCalls = vi.mocked(logger.info).mock.calls.map(
      (c) => String(c[0] ?? ""),
    );

    for (const marker of ["handover:start", "handover:written"]) {
      expect(
        infoCalls.some((msg) => msg.includes(marker)),
        `expected logger.info to be called with a message containing "${marker}". Captured: ${JSON.stringify(infoCalls)}`,
      ).toBe(true);
    }
  });

  it("broadcasts a handover-related status update", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const broadcasts = vi.mocked(multiplexer.broadcastStatus).mock.calls;
    const handoverRelated = broadcasts.filter((call) => {
      const status = call[0] as { message?: string };
      const message = String(status.message ?? "");
      return /debrief|handover/i.test(message);
    });

    expect(handoverRelated.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Group B — Handover read (prior-work context injection)
  // ---------------------------------------------------------------------------

  it("does not inject prior-work context when handoverEnabled is false", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
tickets:
  - id: ticket-1
    title: First ticket
    description: First description
    status: pending
  - id: ticket-2
    title: Second ticket
    description: Second description
    status: pending
`,
    );

    const agent = createMockAgent({
      ticketSessionIds: {
        "ticket-1": "session-ticket-1",
        "ticket-2": "session-ticket-2",
      },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const mainCalls = getCallLog(agent).filter(
      (e) => e.kind === "execute-main",
    );
    expect(mainCalls.length).toBe(2);

    const second = mainCalls.find(
      (e) => e.kind === "execute-main" && e.ticketId === "ticket-2",
    );
    expect(second).toBeDefined();
    if (second?.kind === "execute-main") {
      expect(second.prompt.toLowerCase()).not.toContain("prior work context");
      expect(second.prompt.toLowerCase()).not.toContain(
        "earlier ticket(s)",
      );
    }
  });

  it("injects prior-work pointer context into the second ticket's prompt", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
tickets:
  - id: ticket-1
    title: First ticket
    description: First description
    status: pending
  - id: ticket-2
    title: Second ticket
    description: Second description
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockImplementation(
      async (_root: string, ticketId: string) => `session-${ticketId}`,
    );

    const firstDebrief =
      "# Debrief: ticket-1\n\n## Files modified\n- src/alpha.ts\n\n## Decisions\nMaintainer chose alpha.\n";

    const agent = createMockAgent({
      ticketSessionIds: {
        "ticket-1": "session-ticket-1",
        "ticket-2": "session-ticket-2",
      },
      debriefs: { "ticket-1": firstDebrief },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const mainCalls = getCallLog(agent).filter(
      (e) => e.kind === "execute-main",
    );
    const second = mainCalls.find(
      (e) => e.kind === "execute-main" && e.ticketId === "ticket-2",
    );

    expect(second).toBeDefined();
    if (second?.kind !== "execute-main") return;

    expect(second.prompt.toLowerCase()).toContain("ticket 2 of 2");

    const expectedDebriefDir = join(testDir, ".planbot", "debriefs");
    const expectedDebriefFile = join(expectedDebriefDir, "ticket-1.md");
    const referencesDir = second.prompt.includes(expectedDebriefDir);
    const referencesFile = second.prompt.includes(expectedDebriefFile);
    expect(
      referencesDir || referencesFile,
      `expected second prompt to reference debrief dir ${expectedDebriefDir} or file ${expectedDebriefFile}`,
    ).toBe(true);

    // Pointer-only delivery — the actual debrief contents must NOT be inlined.
    expect(second.prompt).not.toContain("Maintainer chose alpha.");
    expect(second.prompt).not.toContain("src/alpha.ts");
  });

  it("does not inject prior-work context into the first ticket's prompt", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
tickets:
  - id: ticket-1
    title: First ticket
    description: First description
    status: pending
  - id: ticket-2
    title: Second ticket
    description: Second description
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockImplementation(
      async (_root: string, ticketId: string) => `session-${ticketId}`,
    );

    const agent = createMockAgent({
      ticketSessionIds: {
        "ticket-1": "session-ticket-1",
        "ticket-2": "session-ticket-2",
      },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const mainCalls = getCallLog(agent).filter(
      (e) => e.kind === "execute-main",
    );
    const first = mainCalls.find(
      (e) => e.kind === "execute-main" && e.ticketId === "ticket-1",
    );

    expect(first).toBeDefined();
    if (first?.kind === "execute-main") {
      expect(first.prompt.toLowerCase()).not.toContain("prior work context");
    }
  });

  it("omits prior-work context when the prior debrief failed (no completed ids accumulated)", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
tickets:
  - id: ticket-1
    title: First ticket
    description: First description
    status: pending
  - id: ticket-2
    title: Second ticket
    description: Second description
    status: pending
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockImplementation(
      async (_root: string, ticketId: string) => `session-${ticketId}`,
    );

    const agent = createMockAgent({
      ticketSessionIds: {
        "ticket-1": "session-ticket-1",
        "ticket-2": "session-ticket-2",
      },
      // First debrief fails — orchestrator should NOT add ticket-1 to the
      // completedTicketIds list, so ticket-2's prompt should NOT contain a
      // prior-work block at all.
      resumeResults: { "ticket-1": { success: false, error: "rate limit" } },
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const tickets = orchestrator.getTickets();
    expect(tickets.find((t) => t.id === "ticket-1")?.status).toBe("completed");

    const mainCalls = getCallLog(agent).filter(
      (e) => e.kind === "execute-main",
    );
    const second = mainCalls.find(
      (e) => e.kind === "execute-main" && e.ticketId === "ticket-2",
    );
    expect(second).toBeDefined();
    if (second?.kind === "execute-main") {
      expect(second.prompt.toLowerCase()).not.toContain("prior work context");
      expect(second.prompt).not.toContain("ticket-1.md");
    }
  });

  it("lists only the most recent 5 debriefs as pointers when more exist", async () => {
    const ticketsYaml = [
      "config:",
      "  autoApprove: true",
      "  planMode: false",
      "  handoverEnabled: true",
      "tickets:",
    ];
    for (let i = 1; i <= 7; i++) {
      ticketsYaml.push(`  - id: ticket-${i}`);
      ticketsYaml.push(`    title: Ticket ${i}`);
      ticketsYaml.push(`    description: Description ${i}`);
      ticketsYaml.push(`    status: pending`);
    }
    await writeFile(ticketsFilePath, ticketsYaml.join("\n") + "\n");

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockImplementation(
      async (_root: string, ticketId: string) => `session-${ticketId}`,
    );

    const ticketSessionIds: Record<string, string> = {};
    const debriefs: Record<string, string> = {};
    for (let i = 1; i <= 7; i++) {
      ticketSessionIds[`ticket-${i}`] = `session-ticket-${i}`;
      debriefs[`ticket-${i}`] =
        `# Debrief: ticket-${i}\n\nWorked on ticket ${i}.\n`;
    }

    const agent = createMockAgent({ ticketSessionIds, debriefs });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const mainCalls = getCallLog(agent).filter(
      (e) => e.kind === "execute-main",
    );
    const seventh = mainCalls.find(
      (e) => e.kind === "execute-main" && e.ticketId === "ticket-7",
    );

    expect(seventh).toBeDefined();
    if (seventh?.kind !== "execute-main") return;

    expect(seventh.prompt.toLowerCase()).toContain("ticket 7 of 7");

    // Most recent 5 (ticket-2 .. ticket-6) should be present; ticket-1 should
    // be outside the pointer window.
    for (let i = 2; i <= 6; i++) {
      const pointer = join(
        testDir,
        ".planbot",
        "debriefs",
        `ticket-${i}.md`,
      );
      expect(
        seventh.prompt.includes(pointer) ||
          seventh.prompt.includes(`ticket-${i}.md`),
        `expected ticket-7 prompt to reference ticket-${i}.md`,
      ).toBe(true);
    }

    const ticket1Pointer = join(
      testDir,
      ".planbot",
      "debriefs",
      "ticket-1.md",
    );
    expect(seventh.prompt.includes(ticket1Pointer)).toBe(false);

    // Sanity: count pointer lines (lines containing `.md`) — should be ≤ 5.
    const pointerLines = seventh.prompt
      .split("\n")
      .filter((line) => /^- ticket-\d+:/.test(line));
    expect(pointerLines.length).toBeLessThanOrEqual(5);
  });

  // ---------------------------------------------------------------------------
  // Group C — Combination with verify-loop
  // ---------------------------------------------------------------------------

  it("runs the debrief only after a verify-retry succeeds", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
  verifyRetries: 1
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
    acceptanceCriteria:
      - "Feature must do X"
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
      verifyOutcomes: ["FAIL", "PASS"],
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const log = getCallLog(agent);
    const verifyFeedbackIndex = log.findIndex(
      (e) => e.kind === "resume-verify-feedback",
    );
    const debriefIndex = log.findIndex((e) => e.kind === "resume-debrief");

    expect(verifyFeedbackIndex).toBeGreaterThanOrEqual(0);
    expect(debriefIndex).toBeGreaterThanOrEqual(0);
    // Debrief must come AFTER the verify-retry resume call.
    expect(debriefIndex).toBeGreaterThan(verifyFeedbackIndex);

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
    expect(await fileExists(debriefPath(testDir, "ticket-1"))).toBe(true);
  });

  it("does not generate a debrief when verify-loop exhaustion fails the ticket", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  handoverEnabled: true
  verifyRetries: 1
tickets:
  - id: ticket-1
    title: First ticket
    description: Test description
    status: pending
    acceptanceCriteria:
      - "Feature must do X"
`,
    );

    const { stateManager } = await import("../state.js");
    vi.mocked(stateManager.loadSession).mockResolvedValue("session-ticket-1");

    const agent = createMockAgent({
      ticketSessionIds: { "ticket-1": "session-ticket-1" },
      verifyOutcomes: ["FAIL", "FAIL", "FAIL"],
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("failed");
    expect(countDebriefResumes(agent, "ticket-1")).toBe(0);
    expect(await fileExists(debriefPath(testDir, "ticket-1"))).toBe(false);
  });
});
