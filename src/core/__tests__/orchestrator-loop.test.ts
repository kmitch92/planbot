import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { createOrchestrator, type Orchestrator } from "../orchestrator.js";
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
      loopState: null,
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
    resume: vi.fn().mockResolvedValue({ success: true, sessionId: "mock-session-id" }),
    abort: vi.fn(),
    runPrompt: vi.fn().mockResolvedValue({ success: true, output: "YES" }),
  },
}));

vi.mock("../loop-condition.js", () => ({
  evaluateCondition: vi.fn().mockResolvedValue({ met: false }),
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

import { evaluateCondition } from "../loop-condition.js";
import { claude } from "../claude.js";
import { stateManager } from "../state.js";

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

describe("Orchestrator — loop ticket execution", () => {
  let tmpDir: string;
  let ticketsPath: string;
  let orchestrator: Orchestrator;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), "planbot-loop-test-"));
    ticketsPath = join(tmpDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTicketsFile(tickets: unknown[], config: Record<string, unknown> = {}) {
    const content = stringifyYaml({
      config: { autoApprove: true, planMode: false, ...config },
      tickets,
    });
    await writeFile(ticketsPath, content);
  }

  function createLoopOrchestrator() {
    return createOrchestrator({
      projectRoot: tmpDir,
      ticketsFile: ticketsPath,
      multiplexer,
    });
  }

  it("completes loop when condition is met", async () => {
    const mockEvaluateCondition = vi.mocked(evaluateCondition);
    mockEvaluateCondition
      .mockResolvedValueOnce({ met: false })
      .mockResolvedValueOnce({ met: true });

    await writeTicketsFile([{
      id: "loop-1",
      title: "Loop test",
      description: "Test loop",
      loop: {
        goal: "Test goal",
        condition: { type: "shell", command: "exit 0" },
        maxIterations: 5,
      },
    }]);

    orchestrator = createLoopOrchestrator();

    const completedTickets: string[] = [];
    orchestrator.on("ticket:completed", (ticket) => completedTickets.push(ticket.id));

    const iterationStarts: number[] = [];
    orchestrator.on("loop:iteration-start", (_ticket, iteration) => iterationStarts.push(iteration));

    await orchestrator.start();

    expect(completedTickets).toContain("loop-1");
    expect(iterationStarts).toEqual([0, 1]);
    expect(mockEvaluateCondition).toHaveBeenCalledTimes(2);
  });

  it("stops at maxIterations when condition never met", async () => {
    const mockEvaluateCondition = vi.mocked(evaluateCondition);
    mockEvaluateCondition.mockResolvedValue({ met: false });

    await writeTicketsFile([{
      id: "loop-max",
      title: "Max iterations test",
      description: "Test max",
      loop: {
        goal: "Never achieved",
        condition: { type: "shell", command: "exit 1" },
        maxIterations: 3,
      },
    }]);

    orchestrator = createLoopOrchestrator();

    const completedTickets: string[] = [];
    orchestrator.on("ticket:completed", (ticket) => completedTickets.push(ticket.id));

    await orchestrator.start();

    expect(completedTickets).toContain("loop-max");
    expect(mockEvaluateCondition).toHaveBeenCalledTimes(3);
  });

  it("emits loop iteration events", async () => {
    const mockEvaluateCondition = vi.mocked(evaluateCondition);
    mockEvaluateCondition
      .mockResolvedValueOnce({ met: false })
      .mockResolvedValueOnce({ met: true });

    await writeTicketsFile([{
      id: "loop-events",
      title: "Events test",
      description: "Test events",
      loop: {
        goal: "Test",
        condition: { type: "shell", command: "exit 0" },
        maxIterations: 5,
      },
    }]);

    orchestrator = createLoopOrchestrator();

    const starts: Array<[number, number]> = [];
    const completes: Array<[number, boolean]> = [];

    orchestrator.on("loop:iteration-start", (_ticket, iteration, maxIter) => {
      starts.push([iteration, maxIter]);
    });
    orchestrator.on("loop:iteration-complete", (_ticket, iteration, conditionMet) => {
      completes.push([iteration, conditionMet]);
    });

    await orchestrator.start();

    expect(starts).toEqual([[0, 5], [1, 5]]);
    expect(completes).toEqual([[0, false], [1, true]]);
  });

  it("does not mark ticket complete during loop iterations", async () => {
    const mockEvaluateCondition = vi.mocked(evaluateCondition);
    mockEvaluateCondition.mockResolvedValueOnce({ met: true });

    const { markTicketCompleteInFile } = await import("../tickets-io.js");
    const mockMarkComplete = vi.mocked(markTicketCompleteInFile);

    await writeTicketsFile([{
      id: "loop-suppress",
      title: "Suppress test",
      description: "Test suppress",
      loop: {
        goal: "Test",
        condition: { type: "shell", command: "exit 0" },
        maxIterations: 5,
      },
    }]);

    orchestrator = createLoopOrchestrator();
    await orchestrator.start();

    expect(mockMarkComplete).toHaveBeenCalledTimes(1);
    expect(mockMarkComplete).toHaveBeenCalledWith(ticketsPath, "loop-suppress");
  });

  it("processes non-loop tickets normally", async () => {
    await writeTicketsFile([{
      id: "normal-1",
      title: "Normal ticket",
      description: "No loop",
    }]);

    orchestrator = createLoopOrchestrator();

    const completedTickets: string[] = [];
    orchestrator.on("ticket:completed", (ticket) => completedTickets.push(ticket.id));

    await orchestrator.start();

    expect(completedTickets).toContain("normal-1");
    expect(vi.mocked(evaluateCondition)).not.toHaveBeenCalled();
  });

  it("plans before looping when planMode is true", async () => {
    const mockEvaluateCondition = vi.mocked(evaluateCondition);
    mockEvaluateCondition.mockResolvedValueOnce({ met: true });

    await writeTicketsFile([{
      id: "loop-plan",
      title: "Plan then loop",
      description: "Test plan + loop",
      loop: {
        goal: "Test",
        condition: { type: "shell", command: "exit 0" },
        maxIterations: 3,
      },
    }], { planMode: true, autoApprove: true });

    orchestrator = createLoopOrchestrator();
    await orchestrator.start();

    expect(vi.mocked(claude.generatePlan)).toHaveBeenCalled();
    expect(mockEvaluateCondition).toHaveBeenCalled();
  });
});
