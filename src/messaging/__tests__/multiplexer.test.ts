import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMultiplexer,
  TimeoutError,
  type Multiplexer,
} from "../multiplexer.js";
import type {
  MessagingProvider,
  PlanMessage,
  QuestionMessage,
  StatusMessage,
  ApprovalResponse,
  QuestionResponse,
} from "../types.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

interface MockProvider extends MessagingProvider {
  triggerApproval: (response: ApprovalResponse) => void;
  triggerQuestion: (response: QuestionResponse) => void;
}

function createMockProvider(name: string): MockProvider {
  let onApproval: ((r: ApprovalResponse) => void) | undefined;
  let onQuestionResponse: ((r: QuestionResponse) => void) | undefined;
  let connected = false;

  return {
    name,
    get onApproval() {
      return onApproval;
    },
    set onApproval(fn) {
      onApproval = fn;
    },
    get onQuestionResponse() {
      return onQuestionResponse;
    },
    set onQuestionResponse(fn) {
      onQuestionResponse = fn;
    },
    connect: vi.fn(async () => {
      connected = true;
    }),
    disconnect: vi.fn(async () => {
      connected = false;
    }),
    isConnected: vi.fn(() => connected),
    sendPlanForApproval: vi.fn(async () => {}),
    sendQuestion: vi.fn(async () => {}),
    sendStatus: vi.fn(async () => {}),
    triggerApproval: (r) => onApproval?.(r),
    triggerQuestion: (r) => onQuestionResponse?.(r),
  };
}

function createPlanMessage(planId = "plan-1"): PlanMessage {
  return {
    planId,
    ticketId: "ticket-1",
    ticketTitle: "Test Ticket",
    plan: "Test plan content",
  };
}

function createQuestionMessage(questionId = "question-1"): QuestionMessage {
  return {
    questionId,
    ticketId: "ticket-1",
    ticketTitle: "Test Ticket",
    question: "Test question?",
  };
}

function createStatusMessage(): StatusMessage {
  return {
    ticketId: "ticket-1",
    ticketTitle: "Test Ticket",
    status: "started",
    message: "Processing started",
  };
}

function createApprovalResponse(
  planId: string,
  approved: boolean
): ApprovalResponse {
  return {
    planId,
    approved,
    respondedBy: "user-1",
    respondedAt: new Date(),
  };
}

function createQuestionResponse(questionId: string): QuestionResponse {
  return {
    questionId,
    answer: "Test answer",
    respondedBy: "user-1",
    respondedAt: new Date(),
  };
}

// =============================================================================
// Provider Management Tests
// =============================================================================

describe("Provider Management", () => {
  let multiplexer: Multiplexer;

  beforeEach(() => {
    multiplexer = createMultiplexer();
  });

  it("addProvider registers provider", async () => {
    const provider = createMockProvider("slack");
    multiplexer.addProvider(provider);

    await multiplexer.connectAll();

    expect(provider.connect).toHaveBeenCalledOnce();
  });

  it("addProvider replaces existing provider with same name", async () => {
    const provider1 = createMockProvider("slack");
    const provider2 = createMockProvider("slack");

    multiplexer.addProvider(provider1);
    multiplexer.addProvider(provider2);

    await multiplexer.connectAll();

    expect(provider1.connect).not.toHaveBeenCalled();
    expect(provider2.connect).toHaveBeenCalledOnce();
  });

  it("removeProvider removes provider by name", async () => {
    const provider = createMockProvider("slack");
    multiplexer.addProvider(provider);
    multiplexer.removeProvider("slack");

    await multiplexer.connectAll();

    expect(provider.connect).not.toHaveBeenCalled();
  });

  it("removeProvider no-op for non-existent provider", () => {
    expect(() => multiplexer.removeProvider("nonexistent")).not.toThrow();
  });

  it("multiple providers can be registered", async () => {
    const slackProvider = createMockProvider("slack");
    const discordProvider = createMockProvider("discord");
    const telegramProvider = createMockProvider("telegram");

    multiplexer.addProvider(slackProvider);
    multiplexer.addProvider(discordProvider);
    multiplexer.addProvider(telegramProvider);

    await multiplexer.connectAll();

    expect(slackProvider.connect).toHaveBeenCalledOnce();
    expect(discordProvider.connect).toHaveBeenCalledOnce();
    expect(telegramProvider.connect).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// Connection Lifecycle Tests
// =============================================================================

describe("Connection Lifecycle", () => {
  let multiplexer: Multiplexer;

  beforeEach(() => {
    multiplexer = createMultiplexer();
  });

  it("connectAll connects all registered providers", async () => {
    const slackProvider = createMockProvider("slack");
    const discordProvider = createMockProvider("discord");

    multiplexer.addProvider(slackProvider);
    multiplexer.addProvider(discordProvider);

    await multiplexer.connectAll();

    expect(slackProvider.connect).toHaveBeenCalledOnce();
    expect(discordProvider.connect).toHaveBeenCalledOnce();
  });

  it("connectAll throws if any provider fails", async () => {
    const slackProvider = createMockProvider("slack");
    const discordProvider = createMockProvider("discord");
    const connectionError = new Error("Connection failed");

    vi.mocked(discordProvider.connect).mockRejectedValueOnce(connectionError);

    multiplexer.addProvider(slackProvider);
    multiplexer.addProvider(discordProvider);

    await expect(multiplexer.connectAll()).rejects.toThrow("Connection failed");
  });

  it("disconnectAll disconnects all providers", async () => {
    const slackProvider = createMockProvider("slack");
    const discordProvider = createMockProvider("discord");

    multiplexer.addProvider(slackProvider);
    multiplexer.addProvider(discordProvider);

    await multiplexer.connectAll();
    await multiplexer.disconnectAll();

    expect(slackProvider.disconnect).toHaveBeenCalledOnce();
    expect(discordProvider.disconnect).toHaveBeenCalledOnce();
  });

  it("disconnectAll handles provider disconnect errors gracefully", async () => {
    const slackProvider = createMockProvider("slack");
    const discordProvider = createMockProvider("discord");

    vi.mocked(slackProvider.disconnect).mockRejectedValueOnce(
      new Error("Disconnect failed")
    );

    multiplexer.addProvider(slackProvider);
    multiplexer.addProvider(discordProvider);

    await multiplexer.connectAll();

    await expect(multiplexer.disconnectAll()).resolves.not.toThrow();
    expect(discordProvider.disconnect).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// Approval Flow Tests
// =============================================================================

describe("Approval Flow", () => {
  describe("with fake timers", () => {
    let multiplexer: Multiplexer;

    beforeEach(() => {
      vi.useFakeTimers();
      multiplexer = createMultiplexer({ approvalTimeout: 100 });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("requestApproval throws if no providers registered", async () => {
      const plan = createPlanMessage();

      await expect(multiplexer.requestApproval(plan)).rejects.toThrow(
        "No messaging providers registered"
      );
    });

    it("requestApproval broadcasts plan to all providers", async () => {
      const slackProvider = createMockProvider("slack");
      const discordProvider = createMockProvider("discord");
      const plan = createPlanMessage();

      multiplexer.addProvider(slackProvider);
      multiplexer.addProvider(discordProvider);
      await multiplexer.connectAll();

      const approvalPromise = multiplexer.requestApproval(plan);

      await vi.advanceTimersByTimeAsync(0);

      expect(slackProvider.sendPlanForApproval).toHaveBeenCalledWith(plan);
      expect(discordProvider.sendPlanForApproval).toHaveBeenCalledWith(plan);

      slackProvider.triggerApproval(createApprovalResponse(plan.planId, true));
      await approvalPromise;
    });

    it("requestApproval resolves with first approval response (first-response-wins)", async () => {
      const slackProvider = createMockProvider("slack");
      const discordProvider = createMockProvider("discord");
      const plan = createPlanMessage();

      multiplexer.addProvider(slackProvider);
      multiplexer.addProvider(discordProvider);
      await multiplexer.connectAll();

      const approvalPromise = multiplexer.requestApproval(plan);

      const slackResponse = createApprovalResponse(plan.planId, true);

      await vi.advanceTimersByTimeAsync(0);
      slackProvider.triggerApproval(slackResponse);

      const result = await approvalPromise;

      expect(result).toEqual(slackResponse);
    });

    it("cancelApproval rejects pending promise", async () => {
      const provider = createMockProvider("slack");
      const plan = createPlanMessage();

      multiplexer.addProvider(provider);
      await multiplexer.connectAll();

      const approvalPromise = multiplexer.requestApproval(plan);

      await vi.advanceTimersByTimeAsync(0);
      multiplexer.cancelApproval(plan.planId);

      await expect(approvalPromise).rejects.toThrow(
        `Approval request cancelled: ${plan.planId}`
      );
    });

    it("second approval response is ignored (first-response-wins)", async () => {
      const slackProvider = createMockProvider("slack");
      const discordProvider = createMockProvider("discord");
      const plan = createPlanMessage();

      multiplexer.addProvider(slackProvider);
      multiplexer.addProvider(discordProvider);
      await multiplexer.connectAll();

      const approvalPromise = multiplexer.requestApproval(plan);

      const slackResponse = createApprovalResponse(plan.planId, true);
      const discordResponse = createApprovalResponse(plan.planId, false);

      await vi.advanceTimersByTimeAsync(0);
      slackProvider.triggerApproval(slackResponse);

      const result = await approvalPromise;

      discordProvider.triggerApproval(discordResponse);

      expect(result.approved).toBe(true);
    });
  });

});

// =============================================================================
// Question Flow Tests
// =============================================================================

describe("Question Flow", () => {
  describe("with fake timers", () => {
    let multiplexer: Multiplexer;

    beforeEach(() => {
      vi.useFakeTimers();
      multiplexer = createMultiplexer({ questionTimeout: 100 });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("askQuestion throws if no providers registered", async () => {
      const question = createQuestionMessage();

      await expect(multiplexer.askQuestion(question)).rejects.toThrow(
        "No messaging providers registered"
      );
    });

    it("askQuestion broadcasts question to all providers", async () => {
      const slackProvider = createMockProvider("slack");
      const discordProvider = createMockProvider("discord");
      const question = createQuestionMessage();

      multiplexer.addProvider(slackProvider);
      multiplexer.addProvider(discordProvider);
      await multiplexer.connectAll();

      const questionPromise = multiplexer.askQuestion(question);

      await vi.advanceTimersByTimeAsync(0);

      expect(slackProvider.sendQuestion).toHaveBeenCalledWith(question);
      expect(discordProvider.sendQuestion).toHaveBeenCalledWith(question);

      slackProvider.triggerQuestion(
        createQuestionResponse(question.questionId)
      );
      await questionPromise;
    });

    it("askQuestion resolves with first response", async () => {
      const slackProvider = createMockProvider("slack");
      const discordProvider = createMockProvider("discord");
      const question = createQuestionMessage();

      multiplexer.addProvider(slackProvider);
      multiplexer.addProvider(discordProvider);
      await multiplexer.connectAll();

      const questionPromise = multiplexer.askQuestion(question);

      const slackResponse = createQuestionResponse(question.questionId);

      await vi.advanceTimersByTimeAsync(0);
      slackProvider.triggerQuestion(slackResponse);

      const result = await questionPromise;

      expect(result).toEqual(slackResponse);
    });

    it("cancelQuestion rejects pending promise", async () => {
      const provider = createMockProvider("slack");
      const question = createQuestionMessage();

      multiplexer.addProvider(provider);
      await multiplexer.connectAll();

      const questionPromise = multiplexer.askQuestion(question);

      await vi.advanceTimersByTimeAsync(0);
      multiplexer.cancelQuestion(question.questionId);

      await expect(questionPromise).rejects.toThrow(
        `Question cancelled: ${question.questionId}`
      );
    });

    it("second question response is ignored (first-response-wins)", async () => {
      const slackProvider = createMockProvider("slack");
      const discordProvider = createMockProvider("discord");
      const question = createQuestionMessage();

      multiplexer.addProvider(slackProvider);
      multiplexer.addProvider(discordProvider);
      await multiplexer.connectAll();

      const questionPromise = multiplexer.askQuestion(question);

      const slackResponse = createQuestionResponse(question.questionId);
      const discordResponse: QuestionResponse = {
        ...createQuestionResponse(question.questionId),
        answer: "Different answer",
      };

      await vi.advanceTimersByTimeAsync(0);
      slackProvider.triggerQuestion(slackResponse);

      const result = await questionPromise;

      discordProvider.triggerQuestion(discordResponse);

      expect(result.answer).toBe("Test answer");
    });
  });

});

// =============================================================================
// Status Broadcast Tests
// =============================================================================

describe("Status Broadcast", () => {
  let multiplexer: Multiplexer;

  beforeEach(() => {
    multiplexer = createMultiplexer();
  });

  it("broadcastStatus sends to all connected providers", async () => {
    const slackProvider = createMockProvider("slack");
    const discordProvider = createMockProvider("discord");
    const status = createStatusMessage();

    multiplexer.addProvider(slackProvider);
    multiplexer.addProvider(discordProvider);
    await multiplexer.connectAll();

    await multiplexer.broadcastStatus(status);

    expect(slackProvider.sendStatus).toHaveBeenCalledWith(status);
    expect(discordProvider.sendStatus).toHaveBeenCalledWith(status);
  });

  it("broadcastStatus skips disconnected providers", async () => {
    const slackProvider = createMockProvider("slack");
    const discordProvider = createMockProvider("discord");
    const status = createStatusMessage();

    multiplexer.addProvider(slackProvider);
    multiplexer.addProvider(discordProvider);

    await multiplexer.connectAll();
    await discordProvider.disconnect();

    await multiplexer.broadcastStatus(status);

    expect(slackProvider.sendStatus).toHaveBeenCalledWith(status);
    expect(discordProvider.sendStatus).not.toHaveBeenCalled();
  });

  it("broadcastStatus handles provider errors gracefully", async () => {
    const slackProvider = createMockProvider("slack");
    const discordProvider = createMockProvider("discord");
    const status = createStatusMessage();
    const errorHandler = vi.fn();

    vi.mocked(slackProvider.sendStatus).mockRejectedValueOnce(
      new Error("Send failed")
    );

    multiplexer.addProvider(slackProvider);
    multiplexer.addProvider(discordProvider);
    multiplexer.on("error", errorHandler);
    await multiplexer.connectAll();

    await multiplexer.broadcastStatus(status);

    expect(discordProvider.sendStatus).toHaveBeenCalledWith(status);
    expect(errorHandler).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// Error Events Tests
// =============================================================================

describe("Error Events", () => {
  let multiplexer: Multiplexer;

  beforeEach(() => {
    vi.useFakeTimers();
    multiplexer = createMultiplexer({ approvalTimeout: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits error event on approval timeout", async () => {
    const provider = createMockProvider("slack");
    const plan = createPlanMessage();
    const errorHandler = vi.fn();

    multiplexer.addProvider(provider);
    multiplexer.on("error", errorHandler);
    await multiplexer.connectAll();

    let caughtError: unknown;
    const approvalPromise = multiplexer.requestApproval(plan).catch((error) => {
      caughtError = error;
    });

    await vi.advanceTimersByTimeAsync(100);
    await approvalPromise;

    expect(caughtError).toBeInstanceOf(TimeoutError);
    expect(errorHandler).toHaveBeenCalledOnce();
    const [emittedError] = errorHandler.mock.calls[0] as [TimeoutError];
    expect(emittedError).toBeInstanceOf(TimeoutError);
    expect(emittedError.operation).toBe("approval");
    expect(emittedError.id).toBe(plan.planId);
  });

  it("emits error event on question timeout", async () => {
    const questionMultiplexer = createMultiplexer({ questionTimeout: 100 });
    const provider = createMockProvider("slack");
    const question = createQuestionMessage();
    const errorHandler = vi.fn();

    questionMultiplexer.addProvider(provider);
    questionMultiplexer.on("error", errorHandler);
    await questionMultiplexer.connectAll();

    let caughtError: unknown;
    const questionPromise = questionMultiplexer
      .askQuestion(question)
      .catch((error) => {
        caughtError = error;
      });

    await vi.advanceTimersByTimeAsync(100);
    await questionPromise;

    expect(caughtError).toBeInstanceOf(TimeoutError);
    expect(errorHandler).toHaveBeenCalledOnce();
    const [emittedError] = errorHandler.mock.calls[0] as [TimeoutError];
    expect(emittedError).toBeInstanceOf(TimeoutError);
    expect(emittedError.operation).toBe("question");
    expect(emittedError.id).toBe(question.questionId);
  });

  it("emits error event on provider send failure", async () => {
    vi.useRealTimers();
    const freshMultiplexer = createMultiplexer();
    const provider = createMockProvider("slack");
    const status = createStatusMessage();
    const errorHandler = vi.fn();
    const sendError = new Error("Send failed");

    vi.mocked(provider.sendStatus).mockRejectedValueOnce(sendError);

    freshMultiplexer.addProvider(provider);
    freshMultiplexer.on("error", errorHandler);
    await freshMultiplexer.connectAll();

    await freshMultiplexer.broadcastStatus(status);

    expect(errorHandler).toHaveBeenCalledOnce();
    const [emittedError, providerName] = errorHandler.mock.calls[0] as [
      Error,
      string,
    ];
    expect(emittedError.message).toBe("Send failed");
    expect(providerName).toBe("slack");
  });
});

