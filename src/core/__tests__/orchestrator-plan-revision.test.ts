import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOrchestrator, type Orchestrator } from "../orchestrator.js";
import { TicketSchema, ConfigSchema, type Ticket } from "../schemas.js";
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
    appendLog: vi.fn().mockResolvedValue(undefined),
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

function createValidTicket(overrides: Partial<Ticket> = {}): Ticket {
  return TicketSchema.parse({
    id: "test-1",
    title: "Test Ticket",
    description: "Test description for the ticket",
    priority: 0,
    status: "pending",
    ...overrides,
  });
}

describe("Orchestrator Plan Revision Loop", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-plan-revision-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("approved on first attempt executes normally", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval).mockResolvedValueOnce({
      planId: "plan-1",
      approved: true,
    });

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    await orchestrator.start();

    expect(mockClaude.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockClaude.execute).toHaveBeenCalledTimes(1);
  });

  it("rejected without feedback skips ticket (backward compat)", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval).mockResolvedValueOnce({
      planId: "plan-1",
      approved: false,
    });

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    const skippedEvents: Ticket[] = [];
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });
    orchestrator.on("ticket:skipped", (ticket) => skippedEvents.push(ticket));

    await orchestrator.start();

    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0].id).toBe("test-1");
    expect(mockClaude.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockClaude.execute).not.toHaveBeenCalled();
  });

  it("rejected with feedback re-generates plan with feedback in prompt", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval)
      .mockResolvedValueOnce({
        planId: "plan-1",
        approved: false,
        rejectionReason: "Update the delay to two minutes",
      })
      .mockResolvedValueOnce({
        planId: "plan-2",
        approved: true,
      });

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    await orchestrator.start();

    expect(mockClaude.generatePlan).toHaveBeenCalledTimes(2);

    const secondCallPrompt = mockClaude.generatePlan.mock.calls[1][0];
    expect(secondCallPrompt).toContain("Update the delay to two minutes");
    expect(secondCallPrompt).toContain("Previous Plan Feedback");
  });

  it("multiple revisions before approval", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval)
      .mockResolvedValueOnce({
        planId: "plan-1",
        approved: false,
        rejectionReason: "First feedback",
      })
      .mockResolvedValueOnce({
        planId: "plan-2",
        approved: false,
        rejectionReason: "Second feedback",
      })
      .mockResolvedValueOnce({
        planId: "plan-3",
        approved: true,
      });

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    await orchestrator.start();

    expect(mockClaude.generatePlan).toHaveBeenCalledTimes(3);
    expect(mockClaude.execute).toHaveBeenCalledTimes(1);
  });

  it("max revisions exhausted skips ticket", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
  maxPlanRevisions: 1
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval)
      .mockResolvedValueOnce({
        planId: "plan-1",
        approved: false,
        rejectionReason: "First feedback",
      })
      .mockResolvedValueOnce({
        planId: "plan-2",
        approved: false,
        rejectionReason: "Second feedback that exhausts limit",
      });

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    const skippedEvents: Ticket[] = [];
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });
    orchestrator.on("ticket:skipped", (ticket) => skippedEvents.push(ticket));

    await orchestrator.start();

    expect(mockClaude.generatePlan).toHaveBeenCalledTimes(2);
    expect(mockClaude.execute).not.toHaveBeenCalled();
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0].id).toBe("test-1");
  });

  it("maxPlanRevisions: 0 skips on reject with feedback", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
  maxPlanRevisions: 0
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval).mockResolvedValueOnce({
      planId: "plan-1",
      approved: false,
      rejectionReason: "Some feedback that cannot trigger revision",
    });

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    const skippedEvents: Ticket[] = [];
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });
    orchestrator.on("ticket:skipped", (ticket) => skippedEvents.push(ticket));

    await orchestrator.start();

    expect(mockClaude.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockClaude.execute).not.toHaveBeenCalled();
    expect(skippedEvents).toHaveLength(1);
  });

  it("ticket:rejected emitted on each rejection", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval)
      .mockResolvedValueOnce({
        planId: "plan-1",
        approved: false,
        rejectionReason: "Needs more detail",
      })
      .mockResolvedValueOnce({
        planId: "plan-2",
        approved: true,
      });

    const rejectedEvents: Array<{ ticket: Ticket; reason?: string }> = [];
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });
    orchestrator.on("ticket:rejected", (ticket, reason) =>
      rejectedEvents.push({ ticket, reason })
    );

    await orchestrator.start();

    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0].reason).toBe("Needs more detail");
  });

  it("ticket:plan-generated emitted on each plan generation", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval)
      .mockResolvedValueOnce({
        planId: "plan-1",
        approved: false,
        rejectionReason: "Revise this",
      })
      .mockResolvedValueOnce({
        planId: "plan-2",
        approved: true,
      });

    const planGeneratedEvents: Array<{ ticket: Ticket; plan: string }> = [];
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });
    orchestrator.on("ticket:plan-generated", (ticket, plan) =>
      planGeneratedEvents.push({ ticket, plan })
    );

    await orchestrator.start();

    expect(planGeneratedEvents).toHaveLength(2);
  });

  it("auto-approve bypasses revision loop", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: true
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    await orchestrator.start();

    expect(multiplexer.requestApproval).not.toHaveBeenCalled();
    expect(mockClaude.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockClaude.execute).toHaveBeenCalledTimes(1);
  });

  it("direct execution mode unaffected", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: false
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();

    const { claude } = await import("../claude.js");
    const mockClaude = vi.mocked(claude);

    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });

    await orchestrator.start();

    expect(mockClaude.generatePlan).not.toHaveBeenCalled();
    expect(mockClaude.execute).toHaveBeenCalledTimes(1);
  });

  it("ticket:rejected emitted with reason on rejection, ticket:approved on approval", async () => {
    const ticketsFilePath = join(testDir, "tickets.yaml");
    await writeFile(
      ticketsFilePath,
      `config:
  planMode: true
  autoApprove: false
tickets:
  - id: test-1
    title: Test Ticket
    description: Test description
    status: pending
`
    );

    const multiplexer = createMockMultiplexer();
    vi.mocked(multiplexer.requestApproval)
      .mockResolvedValueOnce({
        planId: "plan-1",
        approved: false,
        rejectionReason: "Add error handling",
      })
      .mockResolvedValueOnce({
        planId: "plan-2",
        approved: true,
      });

    const rejectedEvents: Array<{ ticket: Ticket; reason?: string }> = [];
    const approvedEvents: Ticket[] = [];
    const orchestrator = createOrchestrator({
      projectRoot: testDir,
      ticketsFile: ticketsFilePath,
      multiplexer,
    });
    orchestrator.on("ticket:rejected", (ticket, reason) =>
      rejectedEvents.push({ ticket, reason })
    );
    orchestrator.on("ticket:approved", (ticket) => approvedEvents.push(ticket));

    await orchestrator.start();

    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0].reason).toBe("Add error handling");
    expect(approvedEvents).toHaveLength(1);
    expect(approvedEvents[0].id).toBe("test-1");
  });

  it("schema defaults maxPlanRevisions to 3", () => {
    const config = ConfigSchema.parse({});
    expect(config.maxPlanRevisions).toBe(3);
  });
});
