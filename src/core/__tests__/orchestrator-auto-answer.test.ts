import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOrchestrator, type Orchestrator } from "../orchestrator.js";
import { TicketSchema, type Ticket } from "../schemas.js";
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
    update: vi.fn().mockImplementation((_path, updates) =>
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
    addPendingQuestion: vi.fn().mockResolvedValue(undefined),
    removePendingQuestion: vi.fn().mockResolvedValue(undefined),
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

describe("Orchestrator Auto-Answer (Autonomous Mode)", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;
  let capturedAnswer: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-auto-answer-test-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    capturedAnswer = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function setupExecuteMockWithQuestion(
    question: { id: string; text: string; options?: string[] }
  ): Promise<void> {
    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    mockClaude.execute.mockImplementation(async (_prompt, _options, callbacks) => {
      if (callbacks?.onQuestion) {
        capturedAnswer = await callbacks.onQuestion(question);
      }
      return { success: true, sessionId: "mock-session" };
    });
  }

  // ===========================================================================
  // Auto-answer: planMode: false (autonomous)
  // ===========================================================================

  describe("when planMode is false (autonomous execution)", () => {
    beforeEach(async () => {
      const ticketsContent = `
config:
  planMode: false
  autoApprove: false
tickets:
  - id: "test-1"
    title: "Test Ticket"
    description: "A test ticket for autonomous mode"
    priority: 0
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);
    });

    it("selects option containing (Recommended) when present", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-1",
        text: "Which approach?",
        options: ["Option A", "Option B (Recommended)"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(capturedAnswer).toBe("Option B (Recommended)");
    });

    it("falls back to first option when no recommended option exists", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-2",
        text: "Which approach?",
        options: ["Option A", "Option B"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(capturedAnswer).toBe("Option A");
    });

    it("responds with 'use your best judgement' when no options provided", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-3",
        text: "How should I structure this?",
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(capturedAnswer).toBe("use your best judgement");
    });

    it("responds with 'use your best judgement' when options array is empty", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-4",
        text: "How should I structure this?",
        options: [],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(capturedAnswer).toBe("use your best judgement");
    });

    it("does NOT call multiplexer.askQuestion", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-5",
        text: "Which approach?",
        options: ["Option A"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(multiplexer.askQuestion).not.toHaveBeenCalled();
    });

    it("does NOT persist pending question to state", async () => {
      const { stateManager } = await import("../state.js");
      const mockStateManager = vi.mocked(stateManager);

      await setupExecuteMockWithQuestion({
        id: "q-6",
        text: "Which approach?",
        options: ["Option A"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(mockStateManager.addPendingQuestion).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Auto-answer: planMode: true + autoApprove: true (autonomous)
  // ===========================================================================

  describe("when planMode is true and autoApprove is true (autonomous)", () => {
    beforeEach(async () => {
      const ticketsContent = `
config:
  planMode: true
  autoApprove: true
tickets:
  - id: "test-1"
    title: "Test Ticket"
    description: "A test ticket for auto-approve mode"
    priority: 0
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);
    });

    it("auto-answers questions same as planMode false", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-7",
        text: "Which approach?",
        options: ["Option A", "Option B (Recommended)"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(capturedAnswer).toBe("Option B (Recommended)");
    });

    it("does NOT call multiplexer.askQuestion", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-8",
        text: "Which approach?",
        options: ["Option A"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(multiplexer.askQuestion).not.toHaveBeenCalled();
    });

    it("responds with 'use your best judgement' when no options provided", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-9",
        text: "How should I handle errors?",
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(capturedAnswer).toBe("use your best judgement");
    });
  });

  // ===========================================================================
  // Regression: planMode: true + autoApprove: false (interactive mode)
  // ===========================================================================

  describe("when planMode is true and autoApprove is false (interactive mode)", () => {
    beforeEach(async () => {
      const ticketsContent = `
config:
  planMode: true
  autoApprove: false
tickets:
  - id: "test-1"
    title: "Test Ticket"
    description: "A test ticket for interactive mode"
    priority: 0
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);
    });

    it("broadcasts question via multiplexer", async () => {
      await setupExecuteMockWithQuestion({
        id: "q-10",
        text: "Which approach should I use?",
        options: ["Option A", "Option B"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(multiplexer.askQuestion).toHaveBeenCalledWith(
        expect.objectContaining({
          questionId: "q-10",
          ticketId: "test-1",
        })
      );
    });

    it("persists pending question to state", async () => {
      const { stateManager } = await import("../state.js");
      const mockStateManager = vi.mocked(stateManager);

      await setupExecuteMockWithQuestion({
        id: "q-11",
        text: "Which approach?",
        options: ["Option A"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(mockStateManager.addPendingQuestion).toHaveBeenCalledWith(
        testDir,
        expect.objectContaining({
          id: "q-11",
          ticketId: "test-1",
        })
      );
    });
  });

  // ===========================================================================
  // Ticket-level planMode override
  // ===========================================================================

  describe("ticket-level planMode override", () => {
    it("ticket planMode: false overrides config planMode: true for auto-answer", async () => {
      const ticketsContent = `
config:
  planMode: true
  autoApprove: false
tickets:
  - id: "test-override"
    title: "Override Ticket"
    description: "Ticket overrides planMode to false"
    priority: 0
    status: pending
    planMode: false
`;
      await writeFile(ticketsFilePath, ticketsContent);

      await setupExecuteMockWithQuestion({
        id: "q-12",
        text: "Which approach?",
        options: ["Option A (Recommended)", "Option B"],
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(capturedAnswer).toBe("Option A (Recommended)");
      expect(multiplexer.askQuestion).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Permission bypass (skipPermissions forced in autonomous mode)
  // ===========================================================================

  describe("permission bypass in autonomous mode", () => {
    it("planMode: false forces skipPermissions: true in claude.execute", async () => {
      const ticketsContent = `
config:
  planMode: false
  autoApprove: false
tickets:
  - id: "test-perms-1"
    title: "Test Permissions"
    description: "Verify skipPermissions is forced true"
    priority: 0
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const { claude } = await import("../claude.js");
      const mockClaude = vi.mocked(claude);

      mockClaude.execute.mockResolvedValue({
        success: true,
        sessionId: "mock-session",
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(mockClaude.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ skipPermissions: true }),
        expect.any(Object)
      );
    });

    it("autoApprove: true forces skipPermissions: true in claude.execute", async () => {
      const ticketsContent = `
config:
  planMode: true
  autoApprove: true
tickets:
  - id: "test-perms-2"
    title: "Test Permissions"
    description: "Verify skipPermissions is forced true with autoApprove"
    priority: 0
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const { claude } = await import("../claude.js");
      const mockClaude = vi.mocked(claude);

      mockClaude.execute.mockResolvedValue({
        success: true,
        sessionId: "mock-session",
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(mockClaude.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ skipPermissions: true }),
        expect.any(Object)
      );
    });

    it("planMode: true + autoApprove: false preserves config skipPermissions value", async () => {
      const ticketsContent = `
config:
  planMode: true
  autoApprove: false
tickets:
  - id: "test-perms-3"
    title: "Test Permissions"
    description: "Verify skipPermissions stays false in interactive mode"
    priority: 0
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsContent);

      const { claude } = await import("../claude.js");
      const mockClaude = vi.mocked(claude);

      mockClaude.execute.mockResolvedValue({
        success: true,
        sessionId: "mock-session",
      });

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      await orchestrator.start();

      expect(mockClaude.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ skipPermissions: false }),
        expect.any(Object)
      );
    });
  });
});
