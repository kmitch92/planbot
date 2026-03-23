import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOrchestrator } from "../orchestrator.js";
import type { Multiplexer } from "../../messaging/multiplexer.js";
import type { MemorySnapshot } from "../../utils/memory-monitor.js";

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
  formatSnapshotMeta: vi.fn((snapshot: MemorySnapshot) => ({
    rssMb: +snapshot.rssMb.toFixed(1),
    childRssMb: +snapshot.childRssMb.toFixed(1),
    totalRssMb: +(snapshot.rssMb + snapshot.childRssMb).toFixed(1),
    heapUsedMb: +snapshot.heapUsedMb.toFixed(1),
    heapTotalMb: +snapshot.heapTotalMb.toFixed(1),
    externalMb: +snapshot.externalMb.toFixed(1),
    systemAvailableMb: +snapshot.systemAvailableMb.toFixed(1),
    openFds: snapshot.openFds,
  })),
}));

const { mockProcessRegistry } = vi.hoisted(() => ({
  mockProcessRegistry: {
    register: vi.fn(),
    killAll: vi.fn().mockResolvedValue(undefined),
    killAllImmediate: vi.fn().mockResolvedValue(undefined),
    getActiveCount: vi.fn().mockReturnValue(0),
    getActivePids: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../utils/process-lifecycle.js", () => ({
  processRegistry: mockProcessRegistry,
  killWithTimeout: vi.fn().mockResolvedValue(undefined),
  appendBounded: vi.fn((existing: string, text: string) => existing + text),
  MAX_OUTPUT_CHARS: 50_000,
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
import { stateManager } from "../state.js";
import { logger } from "../../utils/logger.js";

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

function createCriticalSnapshot(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    rssMb: 7000,
    heapUsedMb: 3000,
    heapTotalMb: 4000,
    externalMb: 100,
    openFds: 50,
    systemAvailableMb: 25,
    childRssMb: 5000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const TICKETS_YAML = `
config:
  autoApprove: true
  memoryWarningMb: 512
  memoryCriticalMb: 1024
  systemAvailableMinMb: 2048
tickets:
  - id: mem-crit-1
    title: Memory Critical Test
    description: Test memory critical handling
    status: pending
`;

describe("Orchestrator memory critical handling", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-orch-mem-crit-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    vi.clearAllMocks();
    mockMemoryMonitor.isAboveWarning.mockReturnValue(false);
    mockMemoryMonitor.isAboveCeiling.mockReturnValue(false);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("onCritical kills all registered processes, not just main execution", () => {
    it("calls processRegistry.killAll when onCritical fires", async () => {
      await writeFile(ticketsFilePath, TICKETS_YAML);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const startCall = mockMemoryMonitor.start.mock.calls[0][0];
      const onCritical = startCall.onCritical as (snapshot: MemorySnapshot) => void;

      onCritical(createCriticalSnapshot());

      expect(mockProcessRegistry.killAll).toHaveBeenCalledTimes(1);
    });

    it("kills all registered processes even when claude.abort is also called", async () => {
      await writeFile(ticketsFilePath, TICKETS_YAML);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const startCall = mockMemoryMonitor.start.mock.calls[0][0];
      const onCritical = startCall.onCritical as (snapshot: MemorySnapshot) => void;

      onCritical(createCriticalSnapshot());

      expect(mockProcessRegistry.killAll).toHaveBeenCalled();
    });

    it("persists pauseRequested state when onCritical fires", async () => {
      await writeFile(ticketsFilePath, TICKETS_YAML);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const startCall = mockMemoryMonitor.start.mock.calls[0][0];
      const onCritical = startCall.onCritical as (snapshot: MemorySnapshot) => void;

      const mockStateManager = vi.mocked(stateManager);
      mockStateManager.update.mockClear();

      onCritical(createCriticalSnapshot());

      expect(mockStateManager.update).toHaveBeenCalledWith(
        testDir,
        expect.objectContaining({ pauseRequested: true })
      );
    });
  });

  describe("escalation after consecutive critical callbacks", () => {
    it("uses graceful killAll on first critical callback", async () => {
      await writeFile(ticketsFilePath, TICKETS_YAML);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const startCall = mockMemoryMonitor.start.mock.calls[0][0];
      const onCritical = startCall.onCritical as (snapshot: MemorySnapshot) => void;

      onCritical(createCriticalSnapshot());

      expect(mockProcessRegistry.killAll).toHaveBeenCalledTimes(1);
      expect(mockProcessRegistry.killAllImmediate).not.toHaveBeenCalled();
    });

    it("escalates to killAllImmediate (SIGKILL) after 3 consecutive critical callbacks", async () => {
      await writeFile(ticketsFilePath, TICKETS_YAML);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const startCall = mockMemoryMonitor.start.mock.calls[0][0];
      const onCritical = startCall.onCritical as (snapshot: MemorySnapshot) => void;

      onCritical(createCriticalSnapshot());
      onCritical(createCriticalSnapshot());
      onCritical(createCriticalSnapshot());

      expect(mockProcessRegistry.killAllImmediate).toHaveBeenCalledTimes(1);
    });

    it("continues using killAllImmediate on every callback after escalation threshold", async () => {
      await writeFile(ticketsFilePath, TICKETS_YAML);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const startCall = mockMemoryMonitor.start.mock.calls[0][0];
      const onCritical = startCall.onCritical as (snapshot: MemorySnapshot) => void;

      onCritical(createCriticalSnapshot());
      onCritical(createCriticalSnapshot());
      onCritical(createCriticalSnapshot());
      onCritical(createCriticalSnapshot());
      onCritical(createCriticalSnapshot());

      expect(mockProcessRegistry.killAllImmediate).toHaveBeenCalledTimes(3);
    });
  });

  describe("enriched log metadata in callbacks", () => {
    it("onWarning log includes full snapshot metadata and threshold flags", async () => {
      await writeFile(ticketsFilePath, TICKETS_YAML);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const startCall = mockMemoryMonitor.start.mock.calls[0][0];
      const onWarning = startCall.onWarning as (snapshot: MemorySnapshot) => void;

      const snapshot = createCriticalSnapshot({ rssMb: 600, childRssMb: 200 });
      onWarning(snapshot);

      const mockLogger = vi.mocked(logger);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Memory warning threshold hit",
        expect.objectContaining({
          rssMb: expect.any(Number),
          childRssMb: expect.any(Number),
          totalRssMb: expect.any(Number),
          heapUsedMb: expect.any(Number),
          heapTotalMb: expect.any(Number),
          externalMb: expect.any(Number),
          systemAvailableMb: expect.any(Number),
          openFds: expect.any(Number),
          warningMb: 512,
          warningHit: true,
          criticalMb: 1024,
          criticalHit: false,
          systemAvailableMinMb: 2048,
          systemAvailableHit: false,
        }),
      );
    });

    it("onCritical log includes threshold status flags and escalation count", async () => {
      await writeFile(ticketsFilePath, TICKETS_YAML);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const startCall = mockMemoryMonitor.start.mock.calls[0][0];
      const onCritical = startCall.onCritical as (snapshot: MemorySnapshot) => void;

      const snapshot = createCriticalSnapshot({ rssMb: 7000, childRssMb: 5000, systemAvailableMb: 25 });
      onCritical(snapshot);

      const mockLogger = vi.mocked(logger);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Memory CRITICAL - aborting current execution",
        expect.objectContaining({
          rssMb: expect.any(Number),
          childRssMb: expect.any(Number),
          totalRssMb: expect.any(Number),
          heapUsedMb: expect.any(Number),
          heapTotalMb: expect.any(Number),
          externalMb: expect.any(Number),
          systemAvailableMb: expect.any(Number),
          openFds: expect.any(Number),
          warningMb: 512,
          warningHit: true,
          criticalMb: 1024,
          criticalHit: true,
          systemAvailableMinMb: 2048,
          systemAvailableHit: true,
          escalationCount: 1,
        }),
      );
    });
  });
});
