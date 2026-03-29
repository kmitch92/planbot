import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOrchestrator, type Orchestrator } from "../orchestrator.js";
import { type Ticket, TicketSchema } from "../schemas.js";
import type { Multiplexer } from "../../messaging/multiplexer.js";

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
    loadSession: vi.fn().mockResolvedValue("mock-session-id"),
  },
}));

vi.mock("../claude.js", () => ({
  claude: {
    generatePlan: vi.fn().mockResolvedValue({
      success: true,
      plan: "Mock plan content",
      costUsd: 0.01,
    }),
    execute: vi.fn().mockResolvedValue({
      success: true,
      sessionId: "mock-session-id",
    }),
    resume: vi.fn().mockResolvedValue({ success: true }),
    abort: vi.fn(),
  },
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
  getDiskSnapshot: vi.fn().mockResolvedValue({ availableMb: 10000 }),
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

import { claude } from "../claude.js";

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

describe("Orchestrator Pacing Controls", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-pacing-test-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(testDir, { recursive: true, force: true });
  });

  describe("delayBetweenTickets", () => {
    it("fires interruptibleDelay between ticket completions", async () => {
      const ticketsContent = `
config:
  autoApprove: true
  planMode: false
  pacing:
    delayBetweenTickets: "5m"
tickets:
  - id: t1
    title: Ticket 1
    description: First ticket
  - id: t2
    title: Ticket 2
    description: Second ticket
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const completedIds: string[] = [];
      orchestrator.on("ticket:completed", (ticket) => {
        completedIds.push(ticket.id);
      });

      await orchestrator.start();

      expect(completedIds).toContain("t1");
      expect(completedIds).toContain("t2");

      const delayCall = mockInterruptibleDelay.mock.calls.find(
        (call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          return opts.durationMs === 300_000;
        }
      );
      expect(delayCall).toBeDefined();
    });
  });

  describe("delayBetweenRetries", () => {
    it("fires interruptibleDelay between retry attempts", async () => {
      const mockedClaude = vi.mocked(claude);
      mockedClaude.execute
        .mockRejectedValueOnce(new Error("transient failure"))
        .mockResolvedValueOnce({ success: true, sessionId: "mock-session-id" });

      const ticketsContent = `
config:
  autoApprove: true
  planMode: false
  maxRetries: 2
  pacing:
    delayBetweenRetries: "30s"
tickets:
  - id: t1
    title: Ticket 1
    description: First ticket
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      const retryDelayCall = mockInterruptibleDelay.mock.calls.find(
        (call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          return opts.durationMs === 30_000;
        }
      );
      expect(retryDelayCall).toBeDefined();
    });
  });

  describe("global startAfter", () => {
    it("blocks queue start until startAfter time is reached", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-14T20:00:00Z"));

      const ticketsContent = `
config:
  autoApprove: true
  planMode: false
  pacing:
    startAfter: "2026-03-14T22:00:00Z"
tickets:
  - id: t1
    title: Ticket 1
    description: First ticket
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      const startAfterCall = mockInterruptibleDelay.mock.calls.find(
        (call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          const durationMs = opts.durationMs as number;
          return durationMs >= 7_100_000 && durationMs <= 7_300_000;
        }
      );
      expect(startAfterCall).toBeDefined();
    });
  });

  describe("per-ticket startAfter", () => {
    it("blocks individual ticket until its startAfter time", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-15T04:00:00Z"));

      const ticketsContent = `
config:
  autoApprove: true
  planMode: false
tickets:
  - id: t1
    title: Ticket 1
    description: First ticket
  - id: t2
    title: Ticket 2
    description: Second ticket
    pacing:
      startAfter: "2026-03-15T06:00:00Z"
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      const perTicketDelayCall = mockInterruptibleDelay.mock.calls.find(
        (call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          const durationMs = opts.durationMs as number;
          return durationMs >= 7_100_000 && durationMs <= 7_300_000;
        }
      );
      expect(perTicketDelayCall).toBeDefined();
    });
  });

  describe("per-ticket pacing overrides", () => {
    it("uses per-ticket delayBetweenTickets over global config", async () => {
      const ticketsContent = `
config:
  autoApprove: true
  planMode: false
  pacing:
    delayBetweenTickets: "5m"
tickets:
  - id: t1
    title: Ticket 1
    description: First ticket
    pacing:
      delayBetweenTickets: "10m"
  - id: t2
    title: Ticket 2
    description: Second ticket
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      const overrideDelayCall = mockInterruptibleDelay.mock.calls.find(
        (call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          return opts.durationMs === 600_000;
        }
      );
      expect(overrideDelayCall).toBeDefined();

      const globalDelayCall = mockInterruptibleDelay.mock.calls.find(
        (call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          return opts.durationMs === 300_000;
        }
      );
      expect(globalDelayCall).toBeUndefined();
    });
  });

  describe("delay interruption by pause", () => {
    it("emits queue:paused when delay is interrupted", async () => {
      mockInterruptibleDelay.mockResolvedValueOnce({
        completed: true,
        interrupted: false,
        elapsedMs: 0,
      });
      mockInterruptibleDelay.mockResolvedValueOnce({
        completed: false,
        interrupted: true,
        elapsedMs: 1000,
      });

      const ticketsContent = `
config:
  autoApprove: true
  planMode: false
  pacing:
    delayBetweenTickets: "5m"
tickets:
  - id: t1
    title: Ticket 1
    description: First ticket
  - id: t2
    title: Ticket 2
    description: Second ticket
  - id: t3
    title: Ticket 3
    description: Third ticket
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      let pausedEmitted = false;
      orchestrator.on("queue:paused", () => {
        pausedEmitted = true;
      });

      await orchestrator.start();

      expect(pausedEmitted).toBe(true);
    });
  });
});
