import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";

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

describe("Orchestrator Queue Methods", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-orch-queue-test-"));
    ticketsFilePath = join(testDir, "tickets.yaml");

    const ticketsContent = `
config:
  autoApprove: true
tickets: []
`;
    await writeFile(ticketsFilePath, ticketsContent);

    multiplexer = createMockMultiplexer();

    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("queueTicket()", () => {
    it("should add ticket to internal dynamic queue", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const ticket = createValidTicket({ id: "dynamic-1" });

      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(ticket);

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets.some((t) => t.id === "dynamic-1")).toBe(true);
    });

    it("should validate ticket against TicketSchema", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const validTicket = createValidTicket({ id: "valid-ticket" });

      await expect(
        (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(validTicket)
      ).resolves.toBeUndefined();
    });

    it("should throw ZodError for invalid ticket", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const invalidTicket = {
        id: "",
        title: "",
        description: "",
      } as unknown as Ticket;

      await expect(
        (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(invalidTicket)
      ).rejects.toThrow(ZodError);
    });

    it("should allow queuing when orchestrator is not running", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      expect(orchestrator.isRunning()).toBe(false);

      const ticket = createValidTicket({ id: "queued-while-stopped" });

      await expect(
        (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(ticket)
      ).resolves.toBeUndefined();

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets.some((t) => t.id === "queued-while-stopped")).toBe(true);
    });

    it("should allow queuing while orchestrator is running", async () => {
      const ticketsWithPending = `
config:
  autoApprove: true
tickets:
  - id: existing-1
    title: Existing Ticket
    description: An existing ticket
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsWithPending);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      const startPromise = orchestrator.start();

      const ticket = createValidTicket({ id: "queued-while-running" });
      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(ticket);

      await startPromise;

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets.some((t) => t.id === "queued-while-running")).toBe(true);
    });
  });

  describe("getTickets()", () => {
    it("should return empty array when no tickets loaded", () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets).toEqual([]);
    });

    it("should return file tickets when loaded from tickets file", async () => {
      const ticketsWithContent = `
config:
  autoApprove: true
tickets:
  - id: file-ticket-1
    title: File Ticket 1
    description: First ticket from file
    status: pending
  - id: file-ticket-2
    title: File Ticket 2
    description: Second ticket from file
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsWithContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();
      await orchestrator.stop();

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets).toHaveLength(2);
      expect(tickets.map((t) => t.id)).toContain("file-ticket-1");
      expect(tickets.map((t) => t.id)).toContain("file-ticket-2");
    });

    it("should return dynamic tickets when queued", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const ticket1 = createValidTicket({ id: "dynamic-1", title: "Dynamic 1" });
      const ticket2 = createValidTicket({ id: "dynamic-2", title: "Dynamic 2" });

      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(ticket1);
      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(ticket2);

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets).toHaveLength(2);
      expect(tickets.map((t) => t.id)).toEqual(["dynamic-1", "dynamic-2"]);
    });

    it("should return combined file + dynamic tickets", async () => {
      const ticketsWithContent = `
config:
  autoApprove: true
tickets:
  - id: file-ticket
    title: File Ticket
    description: Ticket from file
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsWithContent);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();
      await orchestrator.stop();

      const dynamicTicket = createValidTicket({ id: "dynamic-ticket", title: "Dynamic Ticket" });
      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(dynamicTicket);

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets).toHaveLength(2);
      expect(tickets.map((t) => t.id)).toContain("file-ticket");
      expect(tickets.map((t) => t.id)).toContain("dynamic-ticket");
    });

    it("should not modify original arrays (return copy)", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const ticket = createValidTicket({ id: "immutable-test" });
      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(ticket);

      const tickets1 = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      const tickets2 = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();

      expect(tickets1).not.toBe(tickets2);
      expect(tickets1).toEqual(tickets2);

      tickets1.push(createValidTicket({ id: "mutated" }));
      const tickets3 = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets3).toHaveLength(1);
    });
  });

  describe("start() re-entry behavior for continuous mode", () => {
    it("should throw if orchestrator is already running", async () => {
      const { claude } = await import("../claude.js");
      const mockedClaude = vi.mocked(claude);

      let resolveExecution: () => void;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      mockedClaude.execute.mockImplementationOnce(async () => {
        await executionPromise;
        return { success: true, sessionId: "test-session" };
      });

      const ticketsWithPending = `
config:
  autoApprove: true
tickets:
  - id: long-running
    title: Long Running Ticket
    description: A ticket that takes time
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsWithPending);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const startPromise = orchestrator.start();

      await new Promise((resolve) => setTimeout(resolve, 50));

      await expect(orchestrator.start()).rejects.toThrow("Orchestrator is already running");

      resolveExecution!();
      await startPromise;
    });

    it("after stop(), should allow re-start with newly queued tickets", async () => {
      const ticketsWithPending = `
config:
  autoApprove: true
tickets:
  - id: initial-ticket
    title: Initial Ticket
    description: First run ticket
    status: pending
`;
      await writeFile(ticketsFilePath, ticketsWithPending);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();
      expect(orchestrator.isRunning()).toBe(false);

      const newTicket = createValidTicket({ id: "second-run-ticket", title: "Second Run" });
      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(newTicket);

      await orchestrator.start();
      expect(orchestrator.isRunning()).toBe(false);

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets.map((t) => t.id)).toContain("second-run-ticket");
    });

    it("should process dynamic tickets in subsequent start() calls", async () => {
      const emptyTickets = `
config:
  autoApprove: true
tickets: []
`;
      await writeFile(ticketsFilePath, emptyTickets);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      const ticketStartEvents: string[] = [];
      orchestrator.on("ticket:start", (ticket) => {
        ticketStartEvents.push(ticket.id);
      });

      await orchestrator.start();
      expect(ticketStartEvents).toHaveLength(0);

      const dynamicTicket = createValidTicket({ id: "dynamic-processed", title: "Dynamic Processed" });
      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(dynamicTicket);

      await orchestrator.start();

      expect(ticketStartEvents).toContain("dynamic-processed");
    });

    it("should not reload tickets file on re-entry (preserve dynamic tickets)", async () => {
      const initialTickets = `
config:
  autoApprove: true
tickets:
  - id: file-ticket
    title: File Ticket
    description: From file
    status: pending
`;
      await writeFile(ticketsFilePath, initialTickets);

      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
        dryRun: true,
      });

      await orchestrator.start();

      const dynamicTicket = createValidTicket({ id: "dynamic-preserved" });
      await (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(dynamicTicket);

      const modifiedTickets = `
config:
  autoApprove: true
tickets:
  - id: new-file-ticket
    title: New File Ticket
    description: Should not appear
    status: pending
`;
      await writeFile(ticketsFilePath, modifiedTickets);

      await orchestrator.start();

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      expect(tickets.map((t) => t.id)).toContain("dynamic-preserved");
    });
  });

  describe("Ticket validation with TicketSchema", () => {
    it("should accept ticket with all required fields", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const ticket = createValidTicket({
        id: "complete-ticket",
        title: "Complete Ticket",
        description: "Has all required fields",
        priority: 1,
        status: "pending",
      });

      await expect(
        (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(ticket)
      ).resolves.toBeUndefined();
    });

    it("should accept ticket with optional fields", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const ticket = createValidTicket({
        id: "full-ticket",
        title: "Full Ticket",
        description: "Has optional fields too",
        acceptanceCriteria: ["Criterion 1", "Criterion 2"],
        dependencies: [],
        metadata: { custom: "value" },
      });

      await expect(
        (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(ticket)
      ).resolves.toBeUndefined();

      const tickets = (orchestrator as unknown as { getTickets: () => Ticket[] }).getTickets();
      const queued = tickets.find((t) => t.id === "full-ticket");
      expect(queued?.acceptanceCriteria).toEqual(["Criterion 1", "Criterion 2"]);
    });

    it("should reject ticket with missing id", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const invalidTicket = {
        title: "Missing ID",
        description: "No id field",
      } as unknown as Ticket;

      await expect(
        (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(invalidTicket)
      ).rejects.toThrow(ZodError);
    });

    it("should reject ticket with empty title", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const invalidTicket = {
        id: "empty-title",
        title: "",
        description: "Has empty title",
      } as unknown as Ticket;

      await expect(
        (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(invalidTicket)
      ).rejects.toThrow(ZodError);
    });

    it("should reject ticket with invalid status", async () => {
      const orchestrator = createOrchestrator({
        projectRoot: testDir,
        ticketsFile: ticketsFilePath,
        multiplexer,
      });

      const invalidTicket = {
        id: "bad-status",
        title: "Bad Status",
        description: "Has invalid status",
        status: "invalid_status",
      } as unknown as Ticket;

      await expect(
        (orchestrator as unknown as { queueTicket: (t: Ticket) => Promise<void> }).queueTicket(invalidTicket)
      ).rejects.toThrow(ZodError);
    });
  });
});
