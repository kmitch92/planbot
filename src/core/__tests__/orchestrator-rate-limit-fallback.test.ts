import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOrchestrator } from "../orchestrator.js";
import type { Multiplexer } from "../../messaging/multiplexer.js";

// =============================================================================
// Mocks Setup
// =============================================================================

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
    generatePlan: vi.fn(),
    execute: vi.fn(),
    resume: vi.fn(),
    runPrompt: vi.fn(),
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

/**
 * Create a rate limit error result (explicit message)
 */
function createRateLimitError(message: string) {
  return {
    success: false,
    error: message,
    costUsd: 0.001,
  };
}

/**
 * Create a rate limit error result (heuristic pattern)
 */
function createHeuristicRateLimitError() {
  return {
    success: false,
    error: "Request failed",
    costUsd: 0.005,
    outputLength: 100,
  };
}

/**
 * Create a normal error (not rate limit)
 */
function createNormalError(message: string) {
  return {
    success: false,
    error: message,
    costUsd: 0.15,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe("Orchestrator Rate Limit Fallback", () => {
  let testDir: string;
  let ticketsFilePath: string;
  let multiplexer: Multiplexer;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-rate-limit-test-"));
    ticketsFilePath = join(testDir, "tickets.yaml");
    multiplexer = createMockMultiplexer();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Scenario 1: Plan Generation (generatePlan)
  // ===========================================================================

  describe("Plan Generation (generatePlan)", () => {
    describe("when rate limit hit on first attempt", () => {
      it("falls back to fallbackModel and returns plan on success", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-1"
    title: "Test Plan Fallback"
    description: "Test rate limit fallback during plan generation"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { logger } = await import("../../utils/logger.js");
        const mockClaude = vi.mocked(claude);
        const mockLogger = vi.mocked(logger);

        // First call: rate limit error
        // Second call: fallback succeeds
        mockClaude.generatePlan
          .mockResolvedValueOnce(createRateLimitError("You have hit your limit for Claude API usage"))
          .mockResolvedValueOnce({
            success: true,
            plan: "Fallback plan content",
            costUsd: 0.02,
          });

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

        // Verify generatePlan called twice
        expect(mockClaude.generatePlan).toHaveBeenCalledTimes(2);

        // First call with opus
        expect(mockClaude.generatePlan).toHaveBeenNthCalledWith(
          1,
          expect.any(String),
          expect.objectContaining({ model: "opus" }),
          expect.any(Function)
        );

        // Second call with sonnet (fallback)
        expect(mockClaude.generatePlan).toHaveBeenNthCalledWith(
          2,
          expect.any(String),
          expect.objectContaining({ model: "sonnet" }),
          expect.any(Function)
        );

        // Verify warning logged
        expect(mockLogger.warn).toHaveBeenCalledWith(
          "Claude rate limit hit, retrying with fallback model",
          expect.objectContaining({
            originalModel: "opus",
            fallbackModel: "sonnet",
          })
        );

        // Verify execution proceeded with fallback plan
        expect(mockClaude.execute).toHaveBeenCalled();
      });

      it("throws error when fallback also fails with rate limit", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-2"
    title: "Test Plan Fallback Failure"
    description: "Test both models rate limited"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        // Both calls: rate limit errors
        mockClaude.generatePlan
          .mockResolvedValueOnce(createRateLimitError("You have hit your limit for Claude API usage"))
          .mockResolvedValueOnce(createRateLimitError("Usage limit exceeded"));

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await expect(orchestrator.start()).rejects.toThrow("Usage limit exceeded");

        // Verify both models attempted
        expect(mockClaude.generatePlan).toHaveBeenCalledTimes(2);
      });
    });

    describe("when already using fallback model", () => {
      it("does not attempt fallback and throws immediately", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "sonnet"
  fallbackModel: "sonnet"
tickets:
  - id: "test-3"
    title: "Test No Fallback"
    description: "Test no fallback when model equals fallbackModel"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        mockClaude.generatePlan.mockResolvedValue(
          createRateLimitError("Rate limit exceeded")
        );

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await expect(orchestrator.start()).rejects.toThrow("Rate limit exceeded");

        // Verify only called once (no fallback attempt)
        expect(mockClaude.generatePlan).toHaveBeenCalledTimes(1);
      });
    });

    describe("when model is undefined", () => {
      it("falls back to configured fallbackModel", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  fallbackModel: "sonnet"
tickets:
  - id: "test-4"
    title: "Test Undefined Model Fallback"
    description: "Test fallback when model not specified"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        mockClaude.generatePlan
          .mockResolvedValueOnce(createHeuristicRateLimitError())
          .mockResolvedValueOnce({
            success: true,
            plan: "Fallback plan with undefined model",
            costUsd: 0.02,
          });

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

        // Verify fallback called with sonnet
        expect(mockClaude.generatePlan).toHaveBeenNthCalledWith(
          2,
          expect.any(String),
          expect.objectContaining({ model: "sonnet" }),
          expect.any(Function)
        );
      });
    });

    describe("when normal error occurs (not rate limit)", () => {
      it("does not attempt fallback and throws immediately", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-5"
    title: "Test Normal Error"
    description: "Test no fallback for normal errors"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        mockClaude.generatePlan.mockResolvedValue(
          createNormalError("Connection timeout after 900 seconds")
        );

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await expect(orchestrator.start()).rejects.toThrow("Connection timeout");

        // Verify only called once (no fallback for normal errors)
        expect(mockClaude.generatePlan).toHaveBeenCalledTimes(1);
      });
    });

    describe("logging verification", () => {
      it("logs correct model names in warning message", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-6"
    title: "Test Logging"
    description: "Verify log messages"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { logger } = await import("../../utils/logger.js");
        const mockClaude = vi.mocked(claude);
        const mockLogger = vi.mocked(logger);

        mockClaude.generatePlan
          .mockResolvedValueOnce(createRateLimitError("Rate limit exceeded"))
          .mockResolvedValueOnce({
            success: true,
            plan: "Plan after fallback",
            costUsd: 0.02,
          });

        mockClaude.execute.mockResolvedValue({ success: true });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("rate limit"),
          expect.objectContaining({
            originalModel: "opus",
            fallbackModel: "sonnet",
          })
        );
      });
    });
  });

  // ===========================================================================
  // Scenario 2: Execution (executeTicket)
  // ===========================================================================

  describe("Execution (executeTicket)", () => {
    describe("when rate limit hit during execution", () => {
      it("falls back to fallbackModel and completes ticket on success", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-exec-1"
    title: "Test Execution Fallback"
    description: "Test rate limit fallback during execution"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { stateManager } = await import("../state.js");
        const mockClaude = vi.mocked(claude);
        const mockStateManager = vi.mocked(stateManager);

        mockClaude.generatePlan.mockResolvedValue({
          success: true,
          plan: "Test plan",
          costUsd: 0.01,
        });

        // First execute: rate limit
        // Second execute (fallback): success
        mockClaude.execute
          .mockResolvedValueOnce(createRateLimitError("You have hit your limit for Claude API usage"))
          .mockResolvedValueOnce({
            success: true,
            sessionId: "fallback-session-id",
          });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        // Verify execute called twice
        expect(mockClaude.execute).toHaveBeenCalledTimes(2);

        // First call with opus
        expect(mockClaude.execute).toHaveBeenNthCalledWith(
          1,
          expect.any(String),
          expect.objectContaining({ model: "opus" }),
          expect.any(Object)
        );

        // Second call with sonnet
        expect(mockClaude.execute).toHaveBeenNthCalledWith(
          2,
          expect.any(String),
          expect.objectContaining({ model: "sonnet" }),
          expect.any(Object)
        );

        // Verify session saved from fallback result
        expect(mockStateManager.saveSession).toHaveBeenCalledWith(
          testDir,
          "test-exec-1",
          "fallback-session-id"
        );
      });

      it("enters retry logic when fallback also fails", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
  maxRetries: 2
tickets:
  - id: "test-exec-2"
    title: "Test Execution Fallback Failure"
    description: "Test retry logic after fallback fails"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        mockClaude.generatePlan.mockResolvedValue({
          success: true,
          plan: "Test plan",
          costUsd: 0.01,
        });

        // First execute: rate limit with opus
        // Second execute: rate limit with fallback (sonnet)
        // Normal retry logic kicks in after this
        mockClaude.execute
          .mockResolvedValueOnce(createRateLimitError("Rate limit exceeded"))
          .mockResolvedValueOnce(createRateLimitError("Fallback also rate limited"))
          .mockResolvedValueOnce({
            success: true,
            sessionId: "retry-session",
          });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        // Verify: initial + fallback + 1 retry = 3 calls
        expect(mockClaude.execute).toHaveBeenCalledTimes(3);
      });
    });

    describe("session handling with fallback", () => {
      it("saves session from fallback result when sessionId present", async () => {
        const ticketsContent = `
config:
  planMode: false
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-exec-3"
    title: "Test Session Save"
    description: "Verify session saved from fallback"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { stateManager } = await import("../state.js");
        const mockClaude = vi.mocked(claude);
        const mockStateManager = vi.mocked(stateManager);

        mockClaude.execute
          .mockResolvedValueOnce(createHeuristicRateLimitError())
          .mockResolvedValueOnce({
            success: true,
            sessionId: "session-from-fallback",
          });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        expect(mockStateManager.saveSession).toHaveBeenCalledWith(
          testDir,
          "test-exec-3",
          "session-from-fallback"
        );

        expect(mockStateManager.update).toHaveBeenCalledWith(
          testDir,
          expect.objectContaining({ sessionId: "session-from-fallback" })
        );
      });
    });

    describe("hooks execution after fallback", () => {
      it("runs onComplete hook after fallback success", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
hooks:
  onComplete:
    - type: shell
      command: echo "Ticket completed"
tickets:
  - id: "test-exec-4"
    title: "Test Hook After Fallback"
    description: "Verify hooks run after fallback"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { markTicketCompleteInFile } = await import("../tickets-io.js");
        const mockClaude = vi.mocked(claude);
        const mockMarkComplete = vi.mocked(markTicketCompleteInFile);

        mockClaude.generatePlan.mockResolvedValue({
          success: true,
          plan: "Test plan",
          costUsd: 0.01,
        });

        mockClaude.execute
          .mockResolvedValueOnce(createRateLimitError("Rate limit"))
          .mockResolvedValueOnce({ success: true });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        // Verify ticket was marked complete
        expect(mockMarkComplete).toHaveBeenCalledWith(ticketsFilePath, "test-exec-4");
      });
    });

    describe("fallback does not increment retry counter", () => {
      it("only increments retries on normal failures, not rate limits", async () => {
        const ticketsContent = `
config:
  planMode: false
  model: "opus"
  fallbackModel: "sonnet"
  maxRetries: 1
tickets:
  - id: "test-exec-5"
    title: "Test Retry Counter"
    description: "Verify rate limit fallback doesn't count as retry"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        // Rate limit (fallback), then normal error (retry 1), then success
        mockClaude.execute
          .mockResolvedValueOnce(createRateLimitError("Rate limit"))
          .mockResolvedValueOnce(createNormalError("Some error"))
          .mockResolvedValueOnce({ success: true });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        // 3 calls: initial (rate limit) + fallback (normal error) + retry (success)
        expect(mockClaude.execute).toHaveBeenCalledTimes(3);
      });
    });
  });

  // ===========================================================================
  // Scenario 3: Resume (executeWithSession)
  // ===========================================================================

  describe("Resume (executeWithSession)", () => {
    describe("when rate limit hit during resume", () => {
      it("falls back to fallbackModel and completes ticket on success", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-resume-1"
    title: "Test Resume Fallback"
    description: "Test rate limit fallback during session resume"
    priority: 0
    status: executing
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { stateManager } = await import("../state.js");
        const mockClaude = vi.mocked(claude);
        const mockStateManager = vi.mocked(stateManager);

        // Set up state for resuming
        mockStateManager.load.mockResolvedValue({
          version: "1.0.0",
          currentTicketId: "test-resume-1",
          currentPhase: "executing",
          sessionId: "existing-session-id",
          pauseRequested: false,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          pendingQuestions: [],
        });

        mockStateManager.loadSession.mockResolvedValue("existing-session-id");
        mockStateManager.loadPlan.mockResolvedValue("Existing plan");

        // First resume: rate limit
        // Second resume (fallback): success
        mockClaude.resume
          .mockResolvedValueOnce(createRateLimitError("You have hit your limit"))
          .mockResolvedValueOnce({ success: true });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.resume();

        // Verify resume called twice
        expect(mockClaude.resume).toHaveBeenCalledTimes(2);

        // First call with opus
        expect(mockClaude.resume).toHaveBeenNthCalledWith(
          1,
          "existing-session-id",
          expect.any(String),
          expect.objectContaining({ model: "opus" }),
          expect.any(Object)
        );

        // Second call with sonnet (fallback)
        expect(mockClaude.resume).toHaveBeenNthCalledWith(
          2,
          "existing-session-id",
          expect.any(String),
          expect.objectContaining({ model: "sonnet" }),
          expect.any(Object)
        );
      });

      it("throws error when fallback also fails", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-resume-2"
    title: "Test Resume Fallback Failure"
    description: "Test error when both resume attempts fail"
    priority: 0
    status: executing
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { stateManager } = await import("../state.js");
        const mockClaude = vi.mocked(claude);
        const mockStateManager = vi.mocked(stateManager);

        mockStateManager.load.mockResolvedValue({
          version: "1.0.0",
          currentTicketId: "test-resume-2",
          currentPhase: "executing",
          sessionId: "session-id",
          pauseRequested: false,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          pendingQuestions: [],
        });

        mockStateManager.loadSession.mockResolvedValue("session-id");
        mockStateManager.loadPlan.mockResolvedValue("Plan");

        // Both resume calls fail with rate limit
        mockClaude.resume
          .mockResolvedValueOnce(createRateLimitError("Rate limit"))
          .mockResolvedValueOnce(createRateLimitError("Fallback rate limited too"));

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await expect(orchestrator.resume()).rejects.toThrow("Fallback rate limited too");

        expect(mockClaude.resume).toHaveBeenCalledTimes(2);
      });
    });

    describe("when already using fallback model", () => {
      it("does not attempt fallback during resume", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "sonnet"
  fallbackModel: "sonnet"
tickets:
  - id: "test-resume-3"
    title: "Test No Fallback Resume"
    description: "No fallback when model equals fallbackModel"
    priority: 0
    status: executing
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { stateManager } = await import("../state.js");
        const mockClaude = vi.mocked(claude);
        const mockStateManager = vi.mocked(stateManager);

        mockStateManager.load.mockResolvedValue({
          version: "1.0.0",
          currentTicketId: "test-resume-3",
          currentPhase: "executing",
          sessionId: "session",
          pauseRequested: false,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          pendingQuestions: [],
        });

        mockStateManager.loadSession.mockResolvedValue("session");
        mockStateManager.loadPlan.mockResolvedValue("Plan");

        mockClaude.resume.mockResolvedValue(createRateLimitError("Rate limit"));

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await expect(orchestrator.resume()).rejects.toThrow("Rate limit");

        // Only called once (no fallback)
        expect(mockClaude.resume).toHaveBeenCalledTimes(1);
      });
    });

    describe("session handling during resume", () => {
      it("uses same sessionId for both resume attempts", async () => {
        const ticketsContent = `
config:
  planMode: false
  model: "opus"
  fallbackModel: "sonnet"
tickets:
  - id: "test-resume-4"
    title: "Test Session ID Consistency"
    description: "Verify sessionId maintained across fallback"
    priority: 0
    status: executing
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { stateManager } = await import("../state.js");
        const mockClaude = vi.mocked(claude);
        const mockStateManager = vi.mocked(stateManager);

        mockStateManager.load.mockResolvedValue({
          version: "1.0.0",
          currentTicketId: "test-resume-4",
          currentPhase: "executing",
          sessionId: "persistent-session-id",
          pauseRequested: false,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          pendingQuestions: [],
        });

        mockStateManager.loadSession.mockResolvedValue("persistent-session-id");

        mockClaude.resume
          .mockResolvedValueOnce(createHeuristicRateLimitError())
          .mockResolvedValueOnce({ success: true });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.resume();

        // Both calls use same sessionId
        expect(mockClaude.resume).toHaveBeenNthCalledWith(
          1,
          "persistent-session-id",
          expect.any(String),
          expect.any(Object),
          expect.any(Object)
        );

        expect(mockClaude.resume).toHaveBeenNthCalledWith(
          2,
          "persistent-session-id",
          expect.any(String),
          expect.any(Object),
          expect.any(Object)
        );
      });
    });
  });

  // ===========================================================================
  // Scenario 4: Hooks (executeHooks with prompt type)
  // ===========================================================================

  describe("Hooks (executeHooks with prompt type)", () => {
    describe("when rate limit hit in prompt hook", () => {
      it("falls back to fallbackModel and returns success result", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
hooks:
  beforeEach:
    - type: prompt
      command: "Analyze the ticket and provide recommendations"
tickets:
  - id: "test-hook-1"
    title: "Test Hook Fallback"
    description: "Test rate limit fallback in hooks"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        mockClaude.generatePlan.mockResolvedValue({
          success: true,
          plan: "Test plan",
          costUsd: 0.01,
        });

        mockClaude.execute.mockResolvedValue({ success: true });

        // Hook execution: rate limit then fallback success
        mockClaude.runPrompt
          .mockResolvedValueOnce(createRateLimitError("Rate limit in hook"))
          .mockResolvedValueOnce({
            success: true,
            output: "Hook output from fallback",
            costUsd: 0.005,
          });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        // Verify runPrompt called twice for hook
        expect(mockClaude.runPrompt).toHaveBeenCalledTimes(2);

        // First call with opus
        expect(mockClaude.runPrompt).toHaveBeenNthCalledWith(
          1,
          expect.stringContaining("Analyze the ticket"),
          expect.objectContaining({ model: "opus" })
        );

        // Second call with sonnet (fallback)
        expect(mockClaude.runPrompt).toHaveBeenNthCalledWith(
          2,
          expect.stringContaining("Analyze the ticket"),
          expect.objectContaining({ model: "sonnet" })
        );
      });

      it("returns error result when fallback also fails", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
hooks:
  beforeEach:
    - type: prompt
      command: "Analyze ticket"
tickets:
  - id: "test-hook-2"
    title: "Test Hook Fallback Failure"
    description: "Test error when hook fallback fails"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        mockClaude.generatePlan.mockResolvedValue({
          success: true,
          plan: "Test plan",
          costUsd: 0.01,
        });

        mockClaude.execute.mockResolvedValue({ success: true });

        // Both hook attempts fail
        mockClaude.runPrompt
          .mockResolvedValueOnce(createRateLimitError("Rate limit"))
          .mockResolvedValueOnce(createRateLimitError("Fallback failed too"));

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        // Hooks don't throw - they return error results
        await orchestrator.start();

        // Verify both hook attempts made
        expect(mockClaude.runPrompt).toHaveBeenCalledTimes(2);
      });
    });

    describe("fallback result returned to hook executor", () => {
      it("passes fallback output to subsequent hook processing", async () => {
        const ticketsContent = `
config:
  planMode: true
  autoApprove: true
  model: "opus"
  fallbackModel: "sonnet"
hooks:
  onPlanGenerated:
    - type: prompt
      command: "Review the plan"
tickets:
  - id: "test-hook-3"
    title: "Test Hook Output"
    description: "Verify fallback output used correctly"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const mockClaude = vi.mocked(claude);

        mockClaude.generatePlan.mockResolvedValue({
          success: true,
          plan: "Generated plan",
          costUsd: 0.01,
        });

        mockClaude.execute.mockResolvedValue({ success: true });

        mockClaude.runPrompt
          .mockResolvedValueOnce(createHeuristicRateLimitError())
          .mockResolvedValueOnce({
            success: true,
            output: "Fallback hook review: Plan looks good",
            costUsd: 0.003,
          });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        // Hook executed successfully with fallback
        expect(mockClaude.runPrompt).toHaveBeenCalledTimes(2);
      });
    });

    describe("logging for hook fallback", () => {
      it("logs warning with correct context for hook execution", async () => {
        const ticketsContent = `
config:
  planMode: false
  model: "opus"
  fallbackModel: "sonnet"
hooks:
  beforeEach:
    - type: prompt
      command: "Prepare environment"
tickets:
  - id: "test-hook-4"
    title: "Test Hook Logging"
    description: "Verify hook fallback logging"
    priority: 0
    status: pending
`;
        await writeFile(ticketsFilePath, ticketsContent);

        const { claude } = await import("../claude.js");
        const { logger } = await import("../../utils/logger.js");
        const mockClaude = vi.mocked(claude);
        const mockLogger = vi.mocked(logger);

        mockClaude.execute.mockResolvedValue({ success: true });

        mockClaude.runPrompt
          .mockResolvedValueOnce(createRateLimitError("Usage limit exceeded"))
          .mockResolvedValueOnce({
            success: true,
            output: "Fallback output",
          });

        const orchestrator = createOrchestrator({
          projectRoot: testDir,
          ticketsFile: ticketsFilePath,
          multiplexer,
        });

        await orchestrator.start();

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("Rate limit hit in hook"),
          expect.objectContaining({
            originalModel: "opus",
            fallbackModel: "sonnet",
          })
        );
      });
    });
  });
});
