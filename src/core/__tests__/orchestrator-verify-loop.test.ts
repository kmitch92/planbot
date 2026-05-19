import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

vi.mock("../state.js", () => ({
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
    loadSession: vi.fn().mockResolvedValue("session-main-1"),
    addPendingQuestion: vi.fn().mockResolvedValue(undefined),
    removePendingQuestion: vi.fn().mockResolvedValue(undefined),
  },
}));

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

/**
 * Identify a verify-prompt by looking for the protocol tokens described
 * in src/cli/commands/verify.ts:buildVerifyPrompt.
 */
function isVerifyPrompt(prompt: string): boolean {
  return (
    prompt.includes("VERIFY_START") ||
    prompt.includes("verification agent")
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
    lines.push(
      `[CRITERION index=0 status="PASS" reason="ok"]`,
    );
    lines.push(
      `[VERIFY_END ticketId="${ticketId}" result="PASS"]`,
    );
  } else if (outcome === "FAIL") {
    lines.push(
      `[CRITERION index=0 status="FAIL" reason="placeholder code remains"]`,
    );
    lines.push(
      `[VERIFY_END ticketId="${ticketId}" result="FAIL"]`,
    );
  } else {
    lines.push(
      `[CRITERION index=0 status="PASS" reason="ok"]`,
    );
    lines.push(
      `[CRITERION index=1 status="FAIL" reason="missing edge case"]`,
    );
    lines.push(
      `[VERIFY_END ticketId="${ticketId}" result="PARTIAL"]`,
    );
  }

  lines.push(`[VERIFY_COMPLETE summary="0/1 passed"]`);

  const event: StreamEvent = {
    type: "assistant",
    message: lines.join("\n") + "\n",
  };

  callbacks.onEvent?.(event);
}

interface MockAgentConfig {
  /** Queue of verify outcomes, one per verify call, in order. */
  verifyOutcomes?: VerifyOutcome[];
  /** Outcome for verify calls past the queue (defaults to last queued value). */
  defaultVerifyOutcome?: VerifyOutcome;
  /** Session ID returned by the main execute call. */
  mainSessionId?: string;
  /** Ticket ID to use in verify token output. */
  ticketId?: string;
}

function createMockAgent(config: MockAgentConfig = {}): MockAgentProvider {
  const verifyQueue = [...(config.verifyOutcomes ?? [])];
  const defaultOutcome = config.defaultVerifyOutcome ?? "PASS";
  const sessionId = config.mainSessionId ?? "session-main-1";

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
        const next = verifyQueue.shift() ?? defaultOutcome;
        const ticketId = extractVerifyTicketId(prompt) ?? config.ticketId ?? "test-1";
        emitVerifyTokens(ticketId, next, callbacks);
        return { success: true };
      }

      // Main ticket execution path
      callbacks.onEvent?.({
        type: "assistant",
        message: "Working on ticket...",
      });
      return { success: true, sessionId };
    },
  );

  const resume = vi.fn(
    async (
      _sessionId: string,
      _input: string,
      _options: AgentOptions,
      callbacks: ExecutionCallbacks,
    ): Promise<ExecutionResult> => {
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

  return {
    id: "mock-agent",
    generatePlan,
    execute,
    resume,
    runPrompt,
    answerQuestion,
    abort,
  } as unknown as MockAgentProvider;
}

function extractVerifyTicketId(prompt: string): string | null {
  const match = /### Ticket:\s*(\S+)/.exec(prompt);
  return match ? match[1] ?? null : null;
}

function countCalls(
  fn: ReturnType<typeof vi.fn>,
  filter: (args: unknown[]) => boolean,
): number {
  return fn.mock.calls.filter((args) => filter(args as unknown[])).length;
}

function countVerifyExecuteCalls(agent: MockAgentProvider): number {
  return countCalls(agent.execute, (args) => {
    const prompt = args[0];
    return typeof prompt === "string" && isVerifyPrompt(prompt);
  });
}

function countMainExecuteCalls(agent: MockAgentProvider): number {
  return countCalls(agent.execute, (args) => {
    const prompt = args[0];
    return typeof prompt === "string" && !isVerifyPrompt(prompt);
  });
}

// =============================================================================
// Test Suite
// =============================================================================

describe("Orchestrator Verify Loop Integration", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-verify-loop-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // 1. Default: verifyRetries: 0 → no verification runs
  // ===========================================================================

  it("does not run verification when verifyRetries is 0 (default)", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 0
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
    acceptanceCriteria:
      - "File must exist"
`,
    );

    const agent = createMockAgent();
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countMainExecuteCalls(agent)).toBe(1);
    expect(countVerifyExecuteCalls(agent)).toBe(0);
    expect(agent.resume).not.toHaveBeenCalled();

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
  });

  // ===========================================================================
  // 2. verifyRetries: 2, verify passes first time → no retry
  // ===========================================================================

  it("runs verify once and does not retry when verify passes immediately", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 2
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
    acceptanceCriteria:
      - "Behaviour X is implemented"
`,
    );

    const agent = createMockAgent({
      verifyOutcomes: ["PASS"],
      ticketId: "test-1",
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countMainExecuteCalls(agent)).toBe(1);
    expect(countVerifyExecuteCalls(agent)).toBe(1);
    expect(agent.resume).not.toHaveBeenCalled();

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
  });

  // ===========================================================================
  // 3. verifyRetries: 2, verify FAIL then PASS → exactly one retry
  // ===========================================================================

  it("resumes session with feedback and re-verifies when verification fails once", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 2
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
    acceptanceCriteria:
      - "Feature must do X"
`,
    );

    const agent = createMockAgent({
      verifyOutcomes: ["FAIL", "PASS"],
      mainSessionId: "session-main-1",
      ticketId: "test-1",
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countMainExecuteCalls(agent)).toBe(1);
    expect(countVerifyExecuteCalls(agent)).toBe(2);
    expect(agent.resume).toHaveBeenCalledTimes(1);

    // Resume call should reference the main execution session
    const resumeArgs = agent.resume.mock.calls[0];
    const resumeSessionId = resumeArgs[0] as string;
    const resumeInput = resumeArgs[1] as string;

    expect(resumeSessionId).toBe("session-main-1");
    expect(typeof resumeInput).toBe("string");
    expect(resumeInput.toLowerCase()).toMatch(
      /verification|verify|failed|criterion/,
    );
    // Feedback should include the failure reason text emitted by the mock verify
    expect(resumeInput).toContain("placeholder code remains");

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
  });

  // ===========================================================================
  // 4. verifyRetries: 2, verify always fails → ticket marked failed
  // ===========================================================================

  it("marks ticket failed and stops retrying when verify exhausts the retry budget", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 2
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
    acceptanceCriteria:
      - "Implementation must be complete"
`,
    );

    const agent = createMockAgent({
      verifyOutcomes: ["FAIL", "FAIL", "FAIL"],
      defaultVerifyOutcome: "FAIL",
      ticketId: "test-1",
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    // 1 main + 3 verify (initial + 2 retries)
    expect(countMainExecuteCalls(agent)).toBe(1);
    expect(countVerifyExecuteCalls(agent)).toBe(3);
    // Resume called between each retry (after attempt 1, after attempt 2)
    expect(agent.resume).toHaveBeenCalledTimes(2);

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("failed");
  });

  // ===========================================================================
  // 5. Ticket-level verifyRetries overrides config when higher
  // ===========================================================================

  it("uses ticket-level verifyRetries override when set higher than config", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 0
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
    verifyRetries: 1
    acceptanceCriteria:
      - "Override applies"
`,
    );

    const agent = createMockAgent({
      verifyOutcomes: ["FAIL", "PASS"],
      ticketId: "test-1",
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countMainExecuteCalls(agent)).toBe(1);
    expect(countVerifyExecuteCalls(agent)).toBe(2);
    expect(agent.resume).toHaveBeenCalledTimes(1);

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
  });

  // ===========================================================================
  // 6. Ticket-level verifyRetries: 0 disables despite config higher
  // ===========================================================================

  it("disables verify when ticket-level verifyRetries is 0 even if config is higher", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 3
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
    verifyRetries: 0
    acceptanceCriteria:
      - "Verify should be skipped"
`,
    );

    const agent = createMockAgent();
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countMainExecuteCalls(agent)).toBe(1);
    expect(countVerifyExecuteCalls(agent)).toBe(0);
    expect(agent.resume).not.toHaveBeenCalled();

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
  });

  // ===========================================================================
  // 7. No acceptanceCriteria → verify is skipped even with verifyRetries > 0
  // ===========================================================================

  it("skips verify when ticket has no acceptanceCriteria regardless of verifyRetries", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 5
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`,
    );

    const agent = createMockAgent();
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    expect(countMainExecuteCalls(agent)).toBe(1);
    expect(countVerifyExecuteCalls(agent)).toBe(0);
    expect(agent.resume).not.toHaveBeenCalled();

    const tickets = orchestrator.getTickets();
    expect(tickets[0].status).toBe("completed");
  });

  // ===========================================================================
  // 8. Verify-loop emits the structured logger events from Phase 6
  // ===========================================================================

  it("logs structured verify events through the loop (start, result, retry, pass)", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 2
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
    acceptanceCriteria:
      - "Logged events visible"
`,
    );

    const agent = createMockAgent({
      verifyOutcomes: ["FAIL", "PASS"],
      ticketId: "test-1",
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const { logger } = await import("../../utils/logger.js");
    const infoCalls = vi
      .mocked(logger.info)
      .mock.calls.map((c) => String(c[0] ?? ""));

    const expectedMarkers = [
      "verify:start",
      "verify:result",
      "verify:retry",
      "verify:pass",
    ];

    for (const marker of expectedMarkers) {
      const found = infoCalls.some((msg) => msg.includes(marker));
      expect(
        found,
        `expected logger.info to be called with a message containing "${marker}". Captured: ${JSON.stringify(infoCalls)}`,
      ).toBe(true);
    }
  });

  // ===========================================================================
  // 9. Verify-loop broadcasts status updates via the multiplexer
  // ===========================================================================

  it("broadcasts verification status updates through the multiplexer", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 2
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
    acceptanceCriteria:
      - "Status broadcast visible"
`,
    );

    const agent = createMockAgent({
      verifyOutcomes: ["FAIL", "PASS"],
      ticketId: "test-1",
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    const mockBroadcast = vi.mocked(multiplexer.broadcastStatus);
    const verifyRelated = mockBroadcast.mock.calls.filter((call) => {
      const status = call[0] as { message?: string; status?: string };
      const haystack = `${status.message ?? ""} ${status.status ?? ""}`;
      return /verif/i.test(haystack);
    });

    expect(verifyRelated.length).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // 10. Verify exhaustion does not halt subsequent tickets
  // ===========================================================================

  it("continues to next ticket after a verify-exhausted failure", async () => {
    await writeFile(
      ticketsFilePath,
      `config:
  autoApprove: true
  planMode: false
  verifyRetries: 1
tickets:
  - id: ticket-a
    title: Ticket A
    description: First ticket
    status: pending
    acceptanceCriteria:
      - "Will keep failing"
  - id: ticket-b
    title: Ticket B
    description: Second ticket
    status: pending
`,
    );

    const agent = createMockAgent({
      // ticket-a is the only one with acceptanceCriteria — keeps failing
      verifyOutcomes: ["FAIL", "FAIL"],
      defaultVerifyOutcome: "FAIL",
      ticketId: "ticket-a",
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
      agent,
    });

    await orchestrator.start();

    // Two main executions: one per ticket
    expect(countMainExecuteCalls(agent)).toBe(2);
    // Two verify calls (initial + 1 retry) — only on ticket-a
    expect(countVerifyExecuteCalls(agent)).toBe(2);

    const tickets = orchestrator.getTickets();
    const a = tickets.find((t) => t.id === "ticket-a");
    const b = tickets.find((t) => t.id === "ticket-b");

    expect(a?.status).toBe("failed");
    expect(b?.status).toBe("completed");
  });
});
