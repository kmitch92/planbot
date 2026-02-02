import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stateManager } from "../state.js";
import type { PendingQuestion, State } from "../schemas.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("StateManager", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-state-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Directory Initialization (~5 tests)
  // ===========================================================================

  describe("Directory Initialization", () => {
    it("init() creates .planbot directory structure", async () => {
      await stateManager.init(testDir);

      const paths = stateManager.getPaths(testDir);
      const { access } = await import("node:fs/promises");

      await expect(access(paths.root)).resolves.toBeUndefined();
    });

    it("init() creates all subdirectories (plans, logs, questions, sessions)", async () => {
      await stateManager.init(testDir);

      const paths = stateManager.getPaths(testDir);
      const { access } = await import("node:fs/promises");

      await expect(access(paths.plans)).resolves.toBeUndefined();
      await expect(access(paths.logs)).resolves.toBeUndefined();
      await expect(access(paths.questions)).resolves.toBeUndefined();
      await expect(access(paths.sessions)).resolves.toBeUndefined();
    });

    it("init() creates default state.json if missing", async () => {
      await stateManager.init(testDir);

      const paths = stateManager.getPaths(testDir);
      const content = await readFile(paths.state, "utf-8");
      const state = JSON.parse(content) as State;

      expect(state.version).toBe("1.0.0");
      expect(state.currentTicketId).toBeNull();
      expect(state.currentPhase).toBe("idle");
      expect(state.pendingQuestions).toEqual([]);
    });

    it("init() preserves existing state.json", async () => {
      const paths = stateManager.getPaths(testDir);
      await mkdir(paths.root, { recursive: true });

      const existingState: State = {
        version: "1.0.0",
        currentTicketId: "TICKET-123",
        currentPhase: "executing",
        sessionId: "session-abc",
        pauseRequested: true,
        startedAt: "2024-01-01T00:00:00.000Z",
        lastUpdatedAt: "2024-01-01T12:00:00.000Z",
        pendingQuestions: [],
      };

      await writeFile(paths.state, JSON.stringify(existingState, null, 2));

      await stateManager.init(testDir);

      const content = await readFile(paths.state, "utf-8");
      const state = JSON.parse(content) as State;

      expect(state.currentTicketId).toBe("TICKET-123");
      expect(state.currentPhase).toBe("executing");
      expect(state.pauseRequested).toBe(true);
    });

    it("exists() returns true after init, false before", async () => {
      const existsBefore = await stateManager.exists(testDir);
      expect(existsBefore).toBe(false);

      await stateManager.init(testDir);

      const existsAfter = await stateManager.exists(testDir);
      expect(existsAfter).toBe(true);
    });
  });

  // ===========================================================================
  // State Load/Save Lifecycle (~6 tests)
  // ===========================================================================

  describe("State Load/Save Lifecycle", () => {
    it("load() returns default state when no file exists", async () => {
      const state = await stateManager.load(testDir);

      expect(state.version).toBe("1.0.0");
      expect(state.currentTicketId).toBeNull();
      expect(state.currentPhase).toBe("idle");
      expect(state.sessionId).toBeNull();
      expect(state.pauseRequested).toBe(false);
      expect(state.pendingQuestions).toEqual([]);
    });

    it("load() returns parsed state from existing file", async () => {
      await stateManager.init(testDir);

      const paths = stateManager.getPaths(testDir);
      const existingState: State = {
        version: "1.0.0",
        currentTicketId: "TICKET-456",
        currentPhase: "planning",
        sessionId: "session-xyz",
        pauseRequested: false,
        startedAt: "2024-01-15T10:00:00.000Z",
        lastUpdatedAt: "2024-01-15T11:00:00.000Z",
        pendingQuestions: [],
      };

      await writeFile(paths.state, JSON.stringify(existingState, null, 2));

      const state = await stateManager.load(testDir);

      expect(state.currentTicketId).toBe("TICKET-456");
      expect(state.currentPhase).toBe("planning");
      expect(state.sessionId).toBe("session-xyz");
    });

    it("load() throws on malformed JSON", async () => {
      await stateManager.init(testDir);

      const paths = stateManager.getPaths(testDir);
      await writeFile(paths.state, "{ invalid json }");

      await expect(stateManager.load(testDir)).rejects.toThrow();
    });

    it("save() writes state to file", async () => {
      await stateManager.init(testDir);

      const state: State = {
        version: "1.0.0",
        currentTicketId: "TICKET-789",
        currentPhase: "awaiting_approval",
        sessionId: "session-123",
        pauseRequested: false,
        startedAt: "2024-02-01T00:00:00.000Z",
        lastUpdatedAt: "2024-02-01T00:00:00.000Z",
        pendingQuestions: [],
      };

      await stateManager.save(testDir, state);

      const paths = stateManager.getPaths(testDir);
      const content = await readFile(paths.state, "utf-8");
      const savedState = JSON.parse(content) as State;

      expect(savedState.currentTicketId).toBe("TICKET-789");
      expect(savedState.currentPhase).toBe("awaiting_approval");
    });

    it("save() updates lastUpdatedAt timestamp", async () => {
      await stateManager.init(testDir);

      const originalTimestamp = "2024-01-01T00:00:00.000Z";
      const state: State = {
        version: "1.0.0",
        currentTicketId: null,
        currentPhase: "idle",
        sessionId: null,
        pauseRequested: false,
        startedAt: originalTimestamp,
        lastUpdatedAt: originalTimestamp,
        pendingQuestions: [],
      };

      const beforeSave = Date.now();
      await stateManager.save(testDir, state);
      const afterSave = Date.now();

      const paths = stateManager.getPaths(testDir);
      const content = await readFile(paths.state, "utf-8");
      const savedState = JSON.parse(content) as State;

      const savedTimestamp = new Date(savedState.lastUpdatedAt).getTime();
      expect(savedTimestamp).toBeGreaterThanOrEqual(beforeSave);
      expect(savedTimestamp).toBeLessThanOrEqual(afterSave);
    });

    it("update() merges partial updates and saves", async () => {
      await stateManager.init(testDir);

      const initialState = await stateManager.load(testDir);
      expect(initialState.currentPhase).toBe("idle");
      expect(initialState.currentTicketId).toBeNull();

      const updatedState = await stateManager.update(testDir, {
        currentPhase: "executing",
        currentTicketId: "TICKET-999",
      });

      expect(updatedState.currentPhase).toBe("executing");
      expect(updatedState.currentTicketId).toBe("TICKET-999");
      expect(updatedState.version).toBe("1.0.0");

      const reloadedState = await stateManager.load(testDir);
      expect(reloadedState.currentPhase).toBe("executing");
      expect(reloadedState.currentTicketId).toBe("TICKET-999");
    });
  });

  // ===========================================================================
  // Plan Management (~4 tests)
  // ===========================================================================

  describe("Plan Management", () => {
    it("savePlan() creates plan file in .planbot/plans/", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-001";
      const planContent = "# Implementation Plan\n\n1. Step one\n2. Step two";

      await stateManager.savePlan(testDir, ticketId, planContent);

      const paths = stateManager.getPaths(testDir);
      const planPath = join(paths.plans, `${ticketId}.md`);
      const content = await readFile(planPath, "utf-8");

      expect(content).toBe(planContent);
    });

    it("savePlan() returns path to saved plan", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-002";
      const planContent = "# Plan";

      const returnedPath = await stateManager.savePlan(
        testDir,
        ticketId,
        planContent
      );

      const paths = stateManager.getPaths(testDir);
      const expectedPath = join(paths.plans, `${ticketId}.md`);

      expect(returnedPath).toBe(expectedPath);
    });

    it("loadPlan() returns plan content", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-003";
      const planContent = "# Detailed Plan\n\n- Task A\n- Task B";

      await stateManager.savePlan(testDir, ticketId, planContent);
      const loadedPlan = await stateManager.loadPlan(testDir, ticketId);

      expect(loadedPlan).toBe(planContent);
    });

    it("loadPlan() returns null for non-existent plan", async () => {
      await stateManager.init(testDir);

      const loadedPlan = await stateManager.loadPlan(testDir, "NONEXISTENT");

      expect(loadedPlan).toBeNull();
    });
  });

  // ===========================================================================
  // Session Management (~4 tests)
  // ===========================================================================

  describe("Session Management", () => {
    it("saveSession() creates session file in .planbot/sessions/", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-100";
      const sessionId = "session-abc-123";

      await stateManager.saveSession(testDir, ticketId, sessionId);

      const paths = stateManager.getPaths(testDir);
      const sessionPath = join(paths.sessions, `${ticketId}.txt`);
      const content = await readFile(sessionPath, "utf-8");

      expect(content).toBe(sessionId);
    });

    it("loadSession() returns session ID", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-101";
      const sessionId = "session-xyz-456";

      await stateManager.saveSession(testDir, ticketId, sessionId);
      const loadedSession = await stateManager.loadSession(testDir, ticketId);

      expect(loadedSession).toBe(sessionId);
    });

    it("loadSession() returns null for non-existent session", async () => {
      await stateManager.init(testDir);

      const loadedSession = await stateManager.loadSession(
        testDir,
        "NONEXISTENT"
      );

      expect(loadedSession).toBeNull();
    });

    it("loadSession() trims whitespace from content", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-102";
      const sessionId = "session-trimmed";

      const paths = stateManager.getPaths(testDir);
      const sessionPath = join(paths.sessions, `${ticketId}.txt`);
      await writeFile(sessionPath, `  ${sessionId}  \n\n`);

      const loadedSession = await stateManager.loadSession(testDir, ticketId);

      expect(loadedSession).toBe(sessionId);
    });
  });

  // ===========================================================================
  // Pending Questions CRUD (~6 tests)
  // ===========================================================================

  describe("Pending Questions CRUD", () => {
    const createQuestion = (
      id: string,
      ticketId: string = "TICKET-001"
    ): PendingQuestion => ({
      id,
      ticketId,
      question: `Question ${id}`,
      askedAt: new Date().toISOString(),
    });

    it("addPendingQuestion() adds question to state", async () => {
      await stateManager.init(testDir);

      const question = createQuestion("Q-001");

      await stateManager.addPendingQuestion(testDir, question);

      const questions = await stateManager.getPendingQuestions(testDir);
      expect(questions).toHaveLength(1);
      expect(questions[0]?.id).toBe("Q-001");
    });

    it("addPendingQuestion() ignores duplicates (same id)", async () => {
      await stateManager.init(testDir);

      const question1 = createQuestion("Q-DUP");
      const question2: PendingQuestion = {
        ...createQuestion("Q-DUP"),
        question: "Different question text",
      };

      await stateManager.addPendingQuestion(testDir, question1);
      await stateManager.addPendingQuestion(testDir, question2);

      const questions = await stateManager.getPendingQuestions(testDir);
      expect(questions).toHaveLength(1);
      expect(questions[0]?.question).toBe("Question Q-DUP");
    });

    it("removePendingQuestion() removes question by id", async () => {
      await stateManager.init(testDir);

      const question1 = createQuestion("Q-A");
      const question2 = createQuestion("Q-B");

      await stateManager.addPendingQuestion(testDir, question1);
      await stateManager.addPendingQuestion(testDir, question2);

      let questions = await stateManager.getPendingQuestions(testDir);
      expect(questions).toHaveLength(2);

      await stateManager.removePendingQuestion(testDir, "Q-A");

      questions = await stateManager.getPendingQuestions(testDir);
      expect(questions).toHaveLength(1);
      expect(questions[0]?.id).toBe("Q-B");
    });

    it("removePendingQuestion() no-op for non-existent id", async () => {
      await stateManager.init(testDir);

      const question = createQuestion("Q-EXISTING");
      await stateManager.addPendingQuestion(testDir, question);

      await stateManager.removePendingQuestion(testDir, "Q-NONEXISTENT");

      const questions = await stateManager.getPendingQuestions(testDir);
      expect(questions).toHaveLength(1);
      expect(questions[0]?.id).toBe("Q-EXISTING");
    });

    it("getPendingQuestions() returns all pending questions", async () => {
      await stateManager.init(testDir);

      const questions = [
        createQuestion("Q-1"),
        createQuestion("Q-2"),
        createQuestion("Q-3"),
      ];

      for (const q of questions) {
        await stateManager.addPendingQuestion(testDir, q);
      }

      const result = await stateManager.getPendingQuestions(testDir);
      expect(result).toHaveLength(3);
      expect(result.map((q) => q.id)).toEqual(["Q-1", "Q-2", "Q-3"]);
    });

    it("State persists questions across load/save", async () => {
      await stateManager.init(testDir);

      const question = createQuestion("Q-PERSIST", "TICKET-PERSIST");
      await stateManager.addPendingQuestion(testDir, question);

      const state = await stateManager.load(testDir);
      expect(state.pendingQuestions).toHaveLength(1);
      expect(state.pendingQuestions[0]?.id).toBe("Q-PERSIST");

      await stateManager.save(testDir, state);

      const reloadedState = await stateManager.load(testDir);
      expect(reloadedState.pendingQuestions).toHaveLength(1);
      expect(reloadedState.pendingQuestions[0]?.ticketId).toBe("TICKET-PERSIST");
    });
  });

  // ===========================================================================
  // Log Appending (~3 tests)
  // ===========================================================================

  describe("Log Appending", () => {
    it("appendLog() creates log file if missing", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-LOG-001";
      const entry = "First log entry";

      await stateManager.appendLog(testDir, ticketId, entry);

      const paths = stateManager.getPaths(testDir);
      const logPath = join(paths.logs, `${ticketId}.log`);
      const content = await readFile(logPath, "utf-8");

      expect(content).toContain(entry);
    });

    it("appendLog() appends timestamped entry", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-LOG-002";
      const entry = "Test entry with timestamp";

      const beforeAppend = new Date().toISOString().slice(0, 10);
      await stateManager.appendLog(testDir, ticketId, entry);

      const paths = stateManager.getPaths(testDir);
      const logPath = join(paths.logs, `${ticketId}.log`);
      const content = await readFile(logPath, "utf-8");

      expect(content).toMatch(/^\[.*\] Test entry with timestamp\n$/);
      expect(content).toContain(beforeAppend);
    });

    it("appendLog() preserves existing content", async () => {
      await stateManager.init(testDir);

      const ticketId = "TICKET-LOG-003";

      await stateManager.appendLog(testDir, ticketId, "Entry 1");
      await stateManager.appendLog(testDir, ticketId, "Entry 2");
      await stateManager.appendLog(testDir, ticketId, "Entry 3");

      const paths = stateManager.getPaths(testDir);
      const logPath = join(paths.logs, `${ticketId}.log`);
      const content = await readFile(logPath, "utf-8");

      expect(content).toContain("Entry 1");
      expect(content).toContain("Entry 2");
      expect(content).toContain("Entry 3");

      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(3);
    });
  });

  // ===========================================================================
  // Clear and Reset (~2 tests)
  // ===========================================================================

  describe("Clear and Reset", () => {
    it("clear() removes .planbot directory", async () => {
      await stateManager.init(testDir);
      await stateManager.savePlan(testDir, "TICKET-CLEAR", "Plan content");

      const state = await stateManager.load(testDir);
      await stateManager.update(testDir, { currentTicketId: "TICKET-CLEAR" });

      await stateManager.clear(testDir);

      const freshState = await stateManager.load(testDir);
      expect(freshState.currentTicketId).toBeNull();
      expect(freshState.currentPhase).toBe("idle");
    });

    it("clear() reinitializes with fresh state", async () => {
      await stateManager.init(testDir);

      const question: PendingQuestion = {
        id: "Q-CLEAR",
        ticketId: "TICKET-CLEAR",
        question: "Will this be cleared?",
        askedAt: new Date().toISOString(),
      };
      await stateManager.addPendingQuestion(testDir, question);

      let questions = await stateManager.getPendingQuestions(testDir);
      expect(questions).toHaveLength(1);

      await stateManager.clear(testDir);

      questions = await stateManager.getPendingQuestions(testDir);
      expect(questions).toHaveLength(0);

      const exists = await stateManager.exists(testDir);
      expect(exists).toBe(true);
    });
  });
});
