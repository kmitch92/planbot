import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import readline from "node:readline";
import {
  createTerminalProvider,
  type TerminalProviderOptions,
} from "../terminal.js";
import type {
  MessagingProvider,
  PlanMessage,
  QuestionMessage,
  StatusMessage,
  ApprovalResponse,
  QuestionResponse,
} from "../types.js";

vi.mock("node:readline");

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

function setTTY(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: stdin,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: stdout,
    configurable: true,
  });
}

function restoreTTY(): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: originalStdinIsTTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalStdoutIsTTY,
    configurable: true,
  });
}

interface MockReadlineInterface {
  question: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function createMockReadline(answers: string[]): MockReadlineInterface {
  let answerIndex = 0;
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

  const mockRl: MockReadlineInterface = {
    question: vi.fn((prompt: string, callback: (answer: string) => void) => {
      setTimeout(() => callback(answers[answerIndex++] ?? ""), 0);
    }),
    close: vi.fn(() => {
      const closeHandlers = eventHandlers.get("close") ?? [];
      closeHandlers.forEach((handler) => handler());
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
      return mockRl;
    }),
  };

  vi.mocked(readline.createInterface).mockReturnValue(
    mockRl as unknown as readline.Interface
  );
  return mockRl;
}

function createPlanMessage(overrides?: Partial<PlanMessage>): PlanMessage {
  return {
    planId: "plan-1",
    ticketId: "ticket-123",
    ticketTitle: "Implement feature X",
    plan: "1. First step\n2. Second step\n3. Third step",
    ...overrides,
  };
}

function createQuestionMessage(
  overrides?: Partial<QuestionMessage>
): QuestionMessage {
  return {
    questionId: "question-1",
    ticketId: "ticket-123",
    ticketTitle: "Implement feature X",
    question: "Which approach should we use?",
    ...overrides,
  };
}

function createStatusMessage(
  overrides?: Partial<StatusMessage>
): StatusMessage {
  return {
    ticketId: "ticket-123",
    ticketTitle: "Implement feature X",
    status: "started",
    ...overrides,
  };
}

function createProvider(
  options?: TerminalProviderOptions
): MessagingProvider & {
  onApproval?: (response: ApprovalResponse) => void;
  onQuestionResponse?: (response: QuestionResponse) => void;
} {
  return createTerminalProvider(options) as MessagingProvider & {
    onApproval?: (response: ApprovalResponse) => void;
    onQuestionResponse?: (response: QuestionResponse) => void;
  };
}

// =============================================================================
// Connection Lifecycle Tests
// =============================================================================

describe("Connection Lifecycle", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setTTY(true, true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    restoreTTY();
  });

  it("connect creates readline interface when TTY", async () => {
    const mockRl = createMockReadline([]);
    const provider = createProvider();

    await provider.connect();

    expect(readline.createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    expect(mockRl.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(mockRl.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("connect skips readline when not TTY", async () => {
    setTTY(false, false);
    const provider = createProvider();

    await provider.connect();

    expect(readline.createInterface).not.toHaveBeenCalled();
    expect(provider.isConnected()).toBe(true);
  });

  it("connect is no-op when already connected", async () => {
    createMockReadline([]);
    const provider = createProvider();

    await provider.connect();
    await provider.connect();

    expect(readline.createInterface).toHaveBeenCalledTimes(1);
  });

  it("disconnect closes readline interface", async () => {
    const mockRl = createMockReadline([]);
    const provider = createProvider();

    await provider.connect();
    await provider.disconnect();

    expect(mockRl.close).toHaveBeenCalledOnce();
    expect(provider.isConnected()).toBe(false);
  });

  it("isConnected returns correct status", async () => {
    createMockReadline([]);
    const provider = createProvider();

    expect(provider.isConnected()).toBe(false);

    await provider.connect();
    expect(provider.isConnected()).toBe(true);

    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });
});

// =============================================================================
// Box Drawing Utilities Tests
// =============================================================================

describe("Box Drawing Utilities", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setTTY(true, true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    restoreTTY();
  });

  it("box draws with correct width", async () => {
    createMockReadline(["y"]);
    const provider = createProvider({ maxWidth: 40, colors: false });

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage());

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("─".repeat(40));
  });

  it("title is displayed in box header", async () => {
    createMockReadline(["y"]);
    const provider = createProvider({ colors: false });

    await provider.connect();
    await provider.sendPlanForApproval(
      createPlanMessage({ ticketId: "PROJ-456" })
    );

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("Plan for: PROJ-456");
  });

  it("content lines are padded correctly", async () => {
    createMockReadline(["y"]);
    const provider = createProvider({ maxWidth: 60, colors: false });

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage());

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    const lines = output.split("\n").filter((line) => line.includes("│"));

    for (const line of lines) {
      const verticalBars = (line.match(/│/g) ?? []).length;
      expect(verticalBars).toBe(2);
    }
  });

  it("long content is truncated", async () => {
    createMockReadline(["y"]);
    const provider = createProvider({ maxWidth: 30, colors: false });

    const longTitle =
      "This is a very long ticket title that should be truncated";
    await provider.connect();
    await provider.sendPlanForApproval(
      createPlanMessage({ ticketTitle: longTitle })
    );

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("...");
    expect(output).not.toContain(longTitle);
  });
});

// =============================================================================
// Plan Approval Flow Tests
// =============================================================================

describe("Plan Approval Flow", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setTTY(true, true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    restoreTTY();
  });

  it("sendPlanForApproval throws if not connected", async () => {
    const provider = createProvider();

    await expect(
      provider.sendPlanForApproval(createPlanMessage())
    ).rejects.toThrow("Terminal provider not connected");
  });

  it("sendPlanForApproval displays plan in box format", async () => {
    createMockReadline(["y"]);
    const provider = createProvider({ colors: false });

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage());

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("╭");
    expect(output).toContain("╰");
    expect(output).toContain("│");
    expect(output).toContain("Plan for:");
  });

  it("sendPlanForApproval prompts for approval in TTY mode", async () => {
    const mockRl = createMockReadline(["y"]);
    const provider = createProvider({ colors: false });

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage());

    expect(mockRl.question).toHaveBeenCalledWith(
      expect.stringContaining("Approve this plan?"),
      expect.any(Function)
    );
  });

  it('input "y" approves plan', async () => {
    createMockReadline(["y"]);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage({ planId: "plan-y" }));

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-y",
        approved: true,
      })
    );
  });

  it('empty input "" approves plan', async () => {
    createMockReadline([""]);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(
      createPlanMessage({ planId: "plan-empty" })
    );

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-empty",
        approved: true,
      })
    );
  });

  it('input "n" rejects plan', async () => {
    createMockReadline(["n", "Not a good plan"]);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage({ planId: "plan-n" }));

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-n",
        approved: false,
        rejectionReason: "Not a good plan",
      })
    );
  });

  it('input "n" prompts for rejection reason', async () => {
    const mockRl = createMockReadline(["n", "Bad approach"]);
    const provider = createProvider({ colors: false });
    provider.onApproval = vi.fn();

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage());

    const questionCalls = mockRl.question.mock.calls;
    expect(questionCalls.length).toBe(2);
    expect(questionCalls[1][0]).toContain("Reason for rejection");
  });

  it('input "v" requests full view and re-prompts', async () => {
    const mockRl = createMockReadline(["v", "y"]);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage({ planId: "plan-v" }));

    expect(mockRl.question).toHaveBeenCalledTimes(2);
    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-v",
        approved: true,
      })
    );
  });

  it("non-interactive mode auto-approves with warning", async () => {
    setTTY(false, false);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(
      createPlanMessage({ planId: "plan-auto" })
    );

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("Non-interactive mode: auto-approved");
    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-auto",
        approved: true,
      })
    );
  });
});

// =============================================================================
// Question Flow Tests
// =============================================================================

describe("Question Flow", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setTTY(true, true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    restoreTTY();
  });

  it("sendQuestion throws if not connected", async () => {
    const provider = createProvider();

    await expect(
      provider.sendQuestion(createQuestionMessage())
    ).rejects.toThrow("Terminal provider not connected");
  });

  it("sendQuestion displays question text", async () => {
    createMockReadline(["My answer"]);
    const provider = createProvider({ colors: false });
    provider.onQuestionResponse = vi.fn();

    await provider.connect();
    await provider.sendQuestion(
      createQuestionMessage({ question: "What is your preference?" })
    );

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("What is your preference?");
  });

  it("sendQuestion displays options if provided", async () => {
    createMockReadline(["1"]);
    const provider = createProvider({ colors: false });
    provider.onQuestionResponse = vi.fn();

    await provider.connect();
    await provider.sendQuestion(
      createQuestionMessage({
        options: [
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
          { label: "Option C", value: "c" },
        ],
      })
    );

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("Option A");
    expect(output).toContain("Option B");
    expect(output).toContain("Option C");
    expect(output).toContain("1.");
    expect(output).toContain("2.");
    expect(output).toContain("3.");
  });

  it("sendQuestion prompts for answer in TTY mode", async () => {
    const mockRl = createMockReadline(["test answer"]);
    const provider = createProvider({ colors: false });
    provider.onQuestionResponse = vi.fn();

    await provider.connect();
    await provider.sendQuestion(createQuestionMessage());

    expect(mockRl.question).toHaveBeenCalledWith(
      expect.stringContaining("Your answer:"),
      expect.any(Function)
    );
  });

  it("numeric input selects option by index", async () => {
    createMockReadline(["2"]);
    const provider = createProvider({ colors: false });
    const onQuestionResponse = vi.fn();
    provider.onQuestionResponse = onQuestionResponse;

    await provider.connect();
    await provider.sendQuestion(
      createQuestionMessage({
        questionId: "q-numeric",
        options: [
          { label: "First", value: "first" },
          { label: "Second", value: "second" },
          { label: "Third", value: "third" },
        ],
      })
    );

    expect(onQuestionResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: "q-numeric",
        answer: "second",
      })
    );
  });

  it("non-interactive mode cannot answer questions", async () => {
    setTTY(false, false);
    const provider = createProvider({ colors: false });
    const onQuestionResponse = vi.fn();
    provider.onQuestionResponse = onQuestionResponse;

    await provider.connect();
    await provider.sendQuestion(createQuestionMessage());

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("Non-interactive mode: cannot answer question");
    expect(onQuestionResponse).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Status Display Tests
// =============================================================================

describe("Status Display", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setTTY(true, true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    restoreTTY();
  });

  it("sendStatus throws if not connected", async () => {
    const provider = createProvider();

    await expect(provider.sendStatus(createStatusMessage())).rejects.toThrow(
      "Terminal provider not connected"
    );
  });

  it("sendStatus displays status with correct icon", async () => {
    createMockReadline([]);
    const provider = createProvider({ colors: false });

    await provider.connect();
    await provider.sendStatus(
      createStatusMessage({ status: "started", ticketId: "TICK-001" })
    );

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("◐");
    expect(output).toContain("STARTED");
    expect(output).toContain("TICK-001");
  });

  it('status "completed" shows green checkmark', async () => {
    createMockReadline([]);
    const provider = createProvider({ colors: false });

    await provider.connect();
    await provider.sendStatus(createStatusMessage({ status: "completed" }));

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("✓");
    expect(output).toContain("COMPLETED");
  });

  it('status "failed" shows red X with error message', async () => {
    createMockReadline([]);
    const provider = createProvider({ colors: false });

    await provider.connect();
    await provider.sendStatus(
      createStatusMessage({
        status: "failed",
        error: "Connection timed out",
      })
    );

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("✗");
    expect(output).toContain("FAILED");
    expect(output).toContain("Error:");
    expect(output).toContain("Connection timed out");
  });
});

// =============================================================================
// Callback Invocation Tests
// =============================================================================

describe("Callback Invocation", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setTTY(true, true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    restoreTTY();
  });

  it("onApproval callback receives ApprovalResponse", async () => {
    createMockReadline(["y"]);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(
      createPlanMessage({ planId: "callback-test" })
    );

    expect(onApproval).toHaveBeenCalledOnce();
    const response = onApproval.mock.calls[0][0] as ApprovalResponse;
    expect(response.planId).toBe("callback-test");
    expect(response.approved).toBe(true);
    expect(response.respondedBy).toBe("terminal");
    expect(response.respondedAt).toBeInstanceOf(Date);
  });

  it("onQuestionResponse callback receives QuestionResponse", async () => {
    createMockReadline(["My detailed answer"]);
    const provider = createProvider({ colors: false });
    const onQuestionResponse = vi.fn();
    provider.onQuestionResponse = onQuestionResponse;

    await provider.connect();
    await provider.sendQuestion(
      createQuestionMessage({ questionId: "callback-q" })
    );

    expect(onQuestionResponse).toHaveBeenCalledOnce();
    const response = onQuestionResponse.mock.calls[0][0] as QuestionResponse;
    expect(response.questionId).toBe("callback-q");
    expect(response.answer).toBe("My detailed answer");
    expect(response.respondedBy).toBe("terminal");
    expect(response.respondedAt).toBeInstanceOf(Date);
  });

  it('callbacks receive respondedBy: "terminal"', async () => {
    createMockReadline(["y"]);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage());

    const response = onApproval.mock.calls[0][0] as ApprovalResponse;
    expect(response.respondedBy).toBe("terminal");
  });

  it("callbacks receive respondedAt timestamp", async () => {
    createMockReadline(["answer"]);
    const provider = createProvider({ colors: false });
    const onQuestionResponse = vi.fn();
    provider.onQuestionResponse = onQuestionResponse;

    const beforeTime = new Date();
    await provider.connect();
    await provider.sendQuestion(createQuestionMessage());
    const afterTime = new Date();

    const response = onQuestionResponse.mock.calls[0][0] as QuestionResponse;
    expect(response.respondedAt.getTime()).toBeGreaterThanOrEqual(
      beforeTime.getTime()
    );
    expect(response.respondedAt.getTime()).toBeLessThanOrEqual(
      afterTime.getTime()
    );
  });
});

// =============================================================================
// Provider Options Tests
// =============================================================================

describe("Provider Options", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setTTY(true, true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    restoreTTY();
  });

  it("provider name is terminal", () => {
    const provider = createProvider();
    expect(provider.name).toBe("terminal");
  });

  it("showFullPlan option shows all steps", async () => {
    const longPlan = Array.from(
      { length: 10 },
      (_, i) => `${i + 1}. Step ${i + 1}`
    ).join("\n");
    createMockReadline(["y"]);
    const provider = createProvider({ showFullPlan: true, colors: false });
    provider.onApproval = vi.fn();

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage({ plan: longPlan }));

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("Step 10");
    expect(output).not.toContain("... and");
  });

  it("default showFullPlan=false shows summary", async () => {
    const longPlan = Array.from(
      { length: 10 },
      (_, i) => `${i + 1}. Step ${i + 1}`
    ).join("\n");
    createMockReadline(["y"]);
    const provider = createProvider({ showFullPlan: false, colors: false });
    provider.onApproval = vi.fn();

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage({ plan: longPlan }));

    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");

    expect(output).toContain("... and");
    expect(output).toContain("more");
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe("Error Handling", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setTTY(true, true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    restoreTTY();
  });

  it("invalid input prompts again", async () => {
    const mockRl = createMockReadline(["xyz", "y"]);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage());

    expect(mockRl.question).toHaveBeenCalledTimes(2);
    const output = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .join("\n");
    expect(output).toContain("Invalid input");
  });

  it("rejection with empty reason is handled", async () => {
    createMockReadline(["n", ""]);
    const provider = createProvider({ colors: false });
    const onApproval = vi.fn();
    provider.onApproval = onApproval;

    await provider.connect();
    await provider.sendPlanForApproval(createPlanMessage());

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approved: false,
        rejectionReason: undefined,
      })
    );
  });

  it("disconnect when not connected is safe", async () => {
    const provider = createProvider();

    await expect(provider.disconnect()).resolves.not.toThrow();
  });
});
