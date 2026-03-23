import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOrchestrator } from "../orchestrator.js";
import type { Multiplexer } from "../../messaging/multiplexer.js";

// =============================================================================
// Mocks Setup
// =============================================================================

const mockInterruptibleDelay = vi
  .fn()
  .mockResolvedValue({ completed: true, interrupted: false, elapsedMs: 0 });

vi.mock("../../utils/interruptible-delay.js", () => ({
  interruptibleDelay: (...args: unknown[]) => mockInterruptibleDelay(...args),
}));

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
      loopState: null,
    }),
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockImplementation((_path: string, updates: Record<string, unknown>) =>
      Promise.resolve({
        version: "1.0.0",
        currentTicketId: null,
        currentPhase: "idle",
        sessionId: null,
        pauseRequested: false,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        pendingQuestions: [],
        loopState: null,
        ...updates,
      })
    ),
    savePlan: vi.fn().mockResolvedValue("/mock/plan/path.md"),
    loadPlan: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(null),
    addPendingQuestion: vi.fn().mockResolvedValue(undefined),
    removePendingQuestion: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../claude.js", () => ({
  claude: {
    generatePlan: vi.fn(),
    execute: vi.fn(),
    resume: vi.fn(),
    runPrompt: vi.fn(),
    abort: vi.fn(),
  },
  getLastRateLimitResetsAt: vi.fn(),
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

// =============================================================================
// YAML Fixtures
// =============================================================================

const ticketsYamlWithShortTimeout = `
config:
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
  maxRetries: 2
  maxTotalTicketTime: 1000
tickets:
  - id: test-001
    title: Test Ticket
    description: Test description
    planMode: false
`;

const ticketsYamlWithDisabledTimeout = `
config:
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
  maxRetries: 2
  maxTotalTicketTime: 0
tickets:
  - id: test-001
    title: Test Ticket
    description: Test description
    planMode: false
`;

const ticketsYamlWithShortTimeoutAndRateLimit = `
config:
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
  maxRetries: 0
  maxTotalTicketTime: 2000
  rateLimitRetry:
    enabled: true
    maxWaitTime: "6h"
    retryBuffer: "30s"
    fallbackDelay: "5m"
    notifyOnWait: true
tickets:
  - id: test-001
    title: Test Ticket
    description: Test description
    planMode: false
`;

// =============================================================================
// Test Suite: Per-Ticket Wall-Clock Cap
// =============================================================================

describe("Orchestrator Per-Ticket Wall-Clock Cap", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-ticket-timeout-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    vi.clearAllMocks();
    mockInterruptibleDelay.mockResolvedValue({ completed: true, interrupted: false, elapsedMs: 0 });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Test A: Ticket aborted when wall-clock exceeds maxTotalTicketTime
  // ===========================================================================

  it("aborts ticket with timeout error when wall-clock exceeds maxTotalTicketTime", async () => {
    await writeFile(ticketsFilePath, ticketsYamlWithShortTimeout);

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    mockClaude.execute.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { success: true, sessionId: "mock-session" };
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    const failedTickets: Array<{ id: string; error: string }> = [];
    orchestrator.on("ticket:failed", (ticket, error) => {
      failedTickets.push({ id: ticket.id, error });
    });
    orchestrator.on("error", () => {});

    await orchestrator.start();

    expect(failedTickets).toHaveLength(1);
    expect(failedTickets[0]?.error).toMatch(/timeout|wall.clock|exceeded|time.limit/i);
    expect(mockClaude.execute).toHaveBeenCalledTimes(1);
  });

  it("does not retry after wall-clock timeout is reached", async () => {
    await writeFile(ticketsFilePath, ticketsYamlWithShortTimeout);

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    let callCount = 0;
    mockClaude.execute.mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { success: false, error: "Some error" };
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    orchestrator.on("error", () => {});
    await orchestrator.start();

    expect(callCount).toBeLessThanOrEqual(1);
  }, 15000);

  // ===========================================================================
  // Test B: Rate-limit wait respects remaining ticket time
  // ===========================================================================

  it("aborts rather than waiting for rate-limit reset when remaining ticket time is insufficient", async () => {
    await writeFile(ticketsFilePath, ticketsYamlWithShortTimeoutAndRateLimit);

    const { claude, getLastRateLimitResetsAt } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);
    const mockGetResetsAt = vi.mocked(getLastRateLimitResetsAt);

    mockGetResetsAt.mockReturnValue(Math.floor(Date.now() / 1000) + 300);

    mockClaude.execute
      .mockResolvedValueOnce({
        success: false,
        error: "You have hit your limit",
        costUsd: 0.001,
      })
      .mockResolvedValueOnce({
        success: false,
        error: "You have hit your limit",
        costUsd: 0.001,
      });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    orchestrator.on("error", () => {});
    await orchestrator.start();

    const longDelayCalls = mockInterruptibleDelay.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[0] as { durationMs: number };
        return opts.durationMs > 60000;
      }
    );
    expect(longDelayCalls).toHaveLength(0);
  });

  // ===========================================================================
  // Timeout disabled (0) allows unlimited execution
  // ===========================================================================

  it("does not enforce timeout when maxTotalTicketTime is 0 (disabled)", async () => {
    await writeFile(ticketsFilePath, ticketsYamlWithDisabledTimeout);

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    mockClaude.execute.mockResolvedValueOnce({
      success: true,
      sessionId: "mock-session",
    });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    const completedTickets: string[] = [];
    orchestrator.on("ticket:completed", (ticket) => {
      completedTickets.push(ticket.id);
    });
    orchestrator.on("error", () => {});

    await orchestrator.start();

    expect(completedTickets).toContain("test-001");
  });
});
