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

function createRateLimitError(message = "You have hit your limit") {
  return {
    success: false,
    error: message,
    costUsd: 0.001,
  };
}

// =============================================================================
// YAML Fixtures
// =============================================================================

const ticketsYamlEnabled = `
config:
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
  maxRetries: 0
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

const ticketsYamlDisabled = `
config:
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
  maxRetries: 0
tickets:
  - id: test-001
    title: Test Ticket
    description: Test description
    planMode: false
`;

const ticketsYamlNotifyFalse = `
config:
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
  maxRetries: 0
  rateLimitRetry:
    enabled: true
    maxWaitTime: "6h"
    retryBuffer: "30s"
    fallbackDelay: "5m"
    notifyOnWait: false
tickets:
  - id: test-001
    title: Test Ticket
    description: Test description
    planMode: false
`;

// =============================================================================
// Test Suite
// =============================================================================

describe("Orchestrator Rate Limit Retry", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-rate-limit-retry-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    vi.clearAllMocks();
    mockInterruptibleDelay.mockResolvedValue({ completed: true, interrupted: false, elapsedMs: 0 });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // 1. rateLimitRetry disabled (default)
  // ===========================================================================

  it("fails after fallback without waiting when rateLimitRetry is disabled", async () => {
    await writeFile(ticketsFilePath, ticketsYamlDisabled);

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    mockClaude.execute
      .mockResolvedValueOnce(createRateLimitError())
      .mockResolvedValueOnce(createRateLimitError("Fallback also rate limited"));

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    orchestrator.on("error", () => {});
    await orchestrator.start();

    expect(mockClaude.execute).toHaveBeenCalledTimes(2);

    const rateLimitRetryCalls = mockInterruptibleDelay.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[0] as { durationMs: number };
        return opts.durationMs > 60000;
      }
    );
    expect(rateLimitRetryCalls).toHaveLength(0);
  });

  // ===========================================================================
  // 2. Waits and retries successfully after rate limit
  // ===========================================================================

  it("waits and retries successfully after both primary and fallback hit rate limit", async () => {
    await writeFile(ticketsFilePath, ticketsYamlEnabled);

    const { claude, getLastRateLimitResetsAt } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);
    const mockGetResetsAt = vi.mocked(getLastRateLimitResetsAt);

    mockGetResetsAt.mockReturnValue(Math.floor(Date.now() / 1000) + 300);

    mockClaude.execute
      .mockResolvedValueOnce(createRateLimitError())
      .mockResolvedValueOnce(createRateLimitError("Fallback rate limited"))
      .mockResolvedValueOnce({
        success: true,
        sessionId: "retry-session",
      });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    orchestrator.on("error", () => {});
    await orchestrator.start();

    expect(mockClaude.execute).toHaveBeenCalledTimes(3);

    const longDelayCalls = mockInterruptibleDelay.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[0] as { durationMs: number };
        return opts.durationMs > 60000;
      }
    );
    expect(longDelayCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // 3. Does NOT wait when wait exceeds maxWaitTime
  // ===========================================================================

  it("does not wait when rate limit reset time exceeds maxWaitTime", async () => {
    await writeFile(ticketsFilePath, ticketsYamlEnabled);

    const { claude, getLastRateLimitResetsAt } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);
    const mockGetResetsAt = vi.mocked(getLastRateLimitResetsAt);

    mockGetResetsAt.mockReturnValue(Math.floor(Date.now() / 1000) + 25200);

    mockClaude.execute
      .mockResolvedValueOnce(createRateLimitError())
      .mockResolvedValueOnce(createRateLimitError("Fallback rate limited"));

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

    expect(mockClaude.execute).toHaveBeenCalledTimes(2);
  });

  // ===========================================================================
  // 4. Wait is interruptible by pause/stop
  // ===========================================================================

  it("fails without retrying when rate limit wait is interrupted", async () => {
    await writeFile(ticketsFilePath, ticketsYamlEnabled);

    const { claude, getLastRateLimitResetsAt } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);
    const mockGetResetsAt = vi.mocked(getLastRateLimitResetsAt);

    mockGetResetsAt.mockReturnValue(Math.floor(Date.now() / 1000) + 300);

    mockInterruptibleDelay.mockResolvedValueOnce({
      completed: false,
      interrupted: true,
      elapsedMs: 5000,
    });

    mockClaude.execute
      .mockResolvedValueOnce(createRateLimitError())
      .mockResolvedValueOnce(createRateLimitError("Fallback rate limited"));

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    orchestrator.on("error", () => {});
    await orchestrator.start();

    expect(mockClaude.execute).toHaveBeenCalledTimes(2);
  });

  // ===========================================================================
  // 5. Sends notification when notifyOnWait is true
  // ===========================================================================

  it("broadcasts status notification when waiting for rate limit reset with notifyOnWait enabled", async () => {
    await writeFile(ticketsFilePath, ticketsYamlEnabled);

    const { claude, getLastRateLimitResetsAt } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);
    const mockGetResetsAt = vi.mocked(getLastRateLimitResetsAt);
    const mockBroadcastStatus = vi.mocked(multiplexer.broadcastStatus);

    mockGetResetsAt.mockReturnValue(Math.floor(Date.now() / 1000) + 300);

    mockClaude.execute
      .mockResolvedValueOnce(createRateLimitError())
      .mockResolvedValueOnce(createRateLimitError("Fallback rate limited"))
      .mockResolvedValueOnce({ success: true });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    orchestrator.on("error", () => {});
    await orchestrator.start();

    const rateLimitStatusCalls = mockBroadcastStatus.mock.calls.filter(
      (call) => {
        const status = call[0] as { message?: string; status?: string };
        return (
          (status.message && /rate.limit|wait/i.test(status.message)) ||
          (status.status && /wait/i.test(status.status))
        );
      }
    );
    expect(rateLimitStatusCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // 6. No notification when notifyOnWait is false
  // ===========================================================================

  it("does not broadcast rate limit wait notification when notifyOnWait is false", async () => {
    await writeFile(ticketsFilePath, ticketsYamlNotifyFalse);

    const { claude, getLastRateLimitResetsAt } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);
    const mockGetResetsAt = vi.mocked(getLastRateLimitResetsAt);
    const mockBroadcastStatus = vi.mocked(multiplexer.broadcastStatus);

    mockGetResetsAt.mockReturnValue(Math.floor(Date.now() / 1000) + 300);

    mockClaude.execute
      .mockResolvedValueOnce(createRateLimitError())
      .mockResolvedValueOnce(createRateLimitError("Fallback rate limited"))
      .mockResolvedValueOnce({ success: true });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    orchestrator.on("error", () => {});
    await orchestrator.start();

    const rateLimitWaitCalls = mockBroadcastStatus.mock.calls.filter(
      (call) => {
        const status = call[0] as { message?: string };
        return status.message && /rate.limit.*wait|waiting.*rate/i.test(status.message);
      }
    );
    expect(rateLimitWaitCalls).toHaveLength(0);
  });

  // ===========================================================================
  // 7. Uses fallbackDelay when resetsAt is null
  // ===========================================================================

  it("uses fallbackDelay duration when getLastRateLimitResetsAt returns null", async () => {
    await writeFile(ticketsFilePath, ticketsYamlEnabled);

    const { claude, getLastRateLimitResetsAt } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);
    const mockGetResetsAt = vi.mocked(getLastRateLimitResetsAt);

    mockGetResetsAt.mockReturnValue(null);

    mockClaude.execute
      .mockResolvedValueOnce(createRateLimitError())
      .mockResolvedValueOnce(createRateLimitError("Fallback rate limited"))
      .mockResolvedValueOnce({ success: true });

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    orchestrator.on("error", () => {});
    await orchestrator.start();

    const fallbackDelayCalls = mockInterruptibleDelay.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[0] as { durationMs: number };
        return opts.durationMs === 300000;
      }
    );
    expect(fallbackDelayCalls).toHaveLength(1);
  });
});
