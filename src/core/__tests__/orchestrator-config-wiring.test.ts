import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOrchestrator } from "../orchestrator.js";
import type { Multiplexer } from "../../messaging/multiplexer.js";

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
        ...updates,
      })
    ),
    savePlan: vi.fn().mockResolvedValue("/mock/plan/path.md"),
    loadPlan: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(null),
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

const mockMemoryMonitor = {
  start: vi.fn(),
  stop: vi.fn(),
  isAboveWarning: vi.fn().mockReturnValue(false),
  isAboveCeiling: vi.fn().mockReturnValue(false),
  getLatest: vi.fn().mockReturnValue(null),
};

vi.mock("../../utils/memory-monitor.js", () => ({
  createMemoryMonitor: vi.fn(() => mockMemoryMonitor),
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

describe("Orchestrator config wiring", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-orch-wiring-test-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    vi.clearAllMocks();
    mockMemoryMonitor.isAboveWarning.mockReturnValue(false);
    mockMemoryMonitor.isAboveCeiling.mockReturnValue(false);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("systemAvailableMinMb passed to memoryMonitor.start", () => {
    it("passes systemAvailableMinMb from config to memoryMonitor.start", async () => {
      const ticketsContent = `
config:
  autoApprove: true
  memoryWarningMb: 512
  memoryCriticalMb: 800
  systemAvailableMinMb: 3000
tickets:
  - id: sys-mem-1
    title: System Memory Wiring Test
    description: Verify systemAvailableMinMb is forwarded to memory monitor
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      expect(mockMemoryMonitor.start).toHaveBeenCalledWith(
        expect.objectContaining({
          systemAvailableMinMb: 3000,
        })
      );
    });

    it("passes default systemAvailableMinMb (2048) when not explicitly set", async () => {
      const ticketsContent = `
config:
  autoApprove: true
  memoryWarningMb: 512
  memoryCriticalMb: 800
tickets:
  - id: sys-mem-default
    title: Default System Memory Test
    description: Verify default systemAvailableMinMb is forwarded
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      expect(mockMemoryMonitor.start).toHaveBeenCalledWith(
        expect.objectContaining({
          systemAvailableMinMb: 2048,
        })
      );
    });
  });

  describe("maxClaudeHeapMb passed to agent calls", () => {
    it("passes maxClaudeHeapMb as maxHeapMb to agent.generatePlan in plan mode", async () => {
      const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  maxClaudeHeapMb: 6144
tickets:
  - id: heap-plan-1
    title: Heap Plan Wiring Test
    description: Verify maxClaudeHeapMb is forwarded to generatePlan
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const mockClaude = vi.mocked(claude);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(mockClaude.generatePlan).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ maxHeapMb: 6144 }),
        expect.any(Function)
      );
    });

    it("passes maxClaudeHeapMb as maxHeapMb to agent.execute in execution mode", async () => {
      const ticketsContent = `
config:
  planMode: false
  autoApprove: true
  maxClaudeHeapMb: 8192
tickets:
  - id: heap-exec-1
    title: Heap Execute Wiring Test
    description: Verify maxClaudeHeapMb is forwarded to execute
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const mockClaude = vi.mocked(claude);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(mockClaude.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ maxHeapMb: 8192 }),
        expect.any(Object)
      );
    });

    it("passes default maxClaudeHeapMb (4096) as maxHeapMb when not explicitly set", async () => {
      const ticketsContent = `
config:
  planMode: false
  autoApprove: true
tickets:
  - id: heap-default-1
    title: Default Heap Wiring Test
    description: Verify default maxClaudeHeapMb is forwarded
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const mockClaude = vi.mocked(claude);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(mockClaude.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ maxHeapMb: 4096 }),
        expect.any(Object)
      );
    });
  });
});
