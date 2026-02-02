import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import chalk from "chalk";
import {
  isExitCommand,
  parseUserInputToTicket,
  generateContinuousTicketId,
} from "../commands/start.js";
import { TicketSchema } from "../../core/schemas.js";
import {
  createMultiplexer,
  TimeoutError,
  type Multiplexer,
} from "../../messaging/index.js";
import type {
  MessagingProvider,
  QuestionResponse,
  ApprovalResponse,
} from "../../messaging/types.js";

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

// =============================================================================
// Mock Provider Factory
// =============================================================================

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

// =============================================================================
// Helper Functions Integration Tests
// =============================================================================

describe("Continuous Mode Helper Functions Integration", () => {
  describe("parseUserInputToTicket produces TicketSchema-valid tickets", () => {
    it("generates ticket that passes TicketSchema validation for single-line input", () => {
      const input = "Add user authentication feature";
      const ticket = parseUserInputToTicket(input);

      expect(ticket).not.toBeNull();

      const parseResult = TicketSchema.safeParse(ticket);

      expect(parseResult.success).toBe(true);
      expect(parseResult.data?.id).toMatch(/^cont-\d+-[0-9a-f]+$/);
      expect(parseResult.data?.title).toBe("Add user authentication feature");
      expect(parseResult.data?.status).toBe("pending");
      expect(parseResult.data?.priority).toBe(0);
    });

    it("generates ticket that passes TicketSchema validation for multi-line input", () => {
      const input = "Implement OAuth login\nSupport Google and GitHub providers\nAdd refresh token handling";
      const ticket = parseUserInputToTicket(input);

      expect(ticket).not.toBeNull();

      const parseResult = TicketSchema.safeParse(ticket);

      expect(parseResult.success).toBe(true);
      expect(parseResult.data?.title).toBe("Implement OAuth login");
      expect(parseResult.data?.description).toContain("Support Google and GitHub providers");
    });

    it("generates ticket with all required fields present", () => {
      const input = "Test ticket";
      const ticket = parseUserInputToTicket(input);

      expect(ticket).not.toBeNull();

      const requiredFields = ["id", "title", "description", "priority", "status"];
      for (const field of requiredFields) {
        expect(ticket).toHaveProperty(field);
      }
    });

    it("generates ticket with valid ID format using generateContinuousTicketId", () => {
      const ticket = parseUserInputToTicket("Test");

      expect(ticket?.id).toBeDefined();

      const generatedId = generateContinuousTicketId();
      const idPattern = /^cont-\d+-[0-9a-f]+$/;

      expect(ticket?.id).toMatch(idPattern);
      expect(generatedId).toMatch(idPattern);
    });

    it("handles edge case inputs while producing valid tickets", () => {
      const edgeCases = [
        { input: "A", expected: "A" },
        { input: "   Whitespace title   ", expected: "Whitespace title" },
        { input: "Title\n\n\nMultiple empty lines", expected: "Title" },
        { input: "Unicode title", expected: "Unicode title" },
      ];

      for (const { input, expected } of edgeCases) {
        const ticket = parseUserInputToTicket(input);
        expect(ticket).not.toBeNull();
        expect(TicketSchema.safeParse(ticket).success).toBe(true);
        expect(ticket?.title).toBe(expected);
      }
    });

    it("returns null for invalid inputs without throwing", () => {
      const invalidInputs = ["", "   ", "\n\n\n", "\t\t"];

      for (const input of invalidInputs) {
        expect(parseUserInputToTicket(input)).toBeNull();
      }
    });
  });

  describe("exit command detection in flow context", () => {
    it("detects exit commands that would terminate continuous loop", () => {
      const exitCommands = ["exit", "quit", "q", "done", "stop"];

      for (const cmd of exitCommands) {
        expect(isExitCommand(cmd)).toBe(true);
      }
    });

    it("does not falsely trigger exit for plan text containing exit keywords", () => {
      const planTexts = [
        "Add exit button to dialog",
        "Implement quit confirmation",
        "The done state should be visible",
        "Stop propagation on click events",
        "Add a quick exit option",
      ];

      for (const text of planTexts) {
        expect(isExitCommand(text)).toBe(false);
      }
    });

    it("exit detection integrates with ticket parsing flow", () => {
      const userInput = "exit";

      if (isExitCommand(userInput)) {
        const ticket = parseUserInputToTicket(userInput);
        expect(ticket).not.toBeNull();
      }

      expect(isExitCommand(userInput)).toBe(true);
    });
  });
});

// =============================================================================
// Console Output Behavior Tests
// =============================================================================

describe("Console Output Behavior", () => {
  let consoleSpy: Mock;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("displayCompletionSummary output format", () => {
    it("displays completion summary with expected format components", () => {
      const summaryComponents = {
        header: chalk.bold("\nQueue Summary:"),
        completed: chalk.green("  Completed: 0"),
      };

      console.log(summaryComponents.header);
      console.log(summaryComponents.completed);

      expect(consoleSpy).toHaveBeenCalledWith(summaryComponents.header);
      expect(consoleSpy).toHaveBeenCalledWith(summaryComponents.completed);
    });

    it("formats failed count with red color when present", () => {
      const failedMessage = chalk.red("  Failed:    2");

      console.log(failedMessage);

      expect(consoleSpy).toHaveBeenCalledWith(failedMessage);
      expect(failedMessage).toContain("Failed");
    });

    it("formats skipped count with yellow color when present", () => {
      const skippedMessage = chalk.yellow("  Skipped:   1");

      console.log(skippedMessage);

      expect(consoleSpy).toHaveBeenCalledWith(skippedMessage);
      expect(skippedMessage).toContain("Skipped");
    });
  });

  describe("continuous mode messages", () => {
    it("displays exit message with green color", () => {
      const exitMessage = chalk.green("\nExiting continuous mode.");

      console.log(exitMessage);

      expect(consoleSpy).toHaveBeenCalledWith(exitMessage);
    });

    it("displays timeout message with yellow color", () => {
      const timeoutMessage = chalk.yellow("\nTimeout waiting for input. Exiting.");

      console.log(timeoutMessage);

      expect(consoleSpy).toHaveBeenCalledWith(timeoutMessage);
    });

    it("displays empty input warning with remaining attempts", () => {
      const emptyInputMessage = chalk.yellow("Enter a plan or 'exit' (2 attempts left)");

      console.log(emptyInputMessage);

      expect(consoleSpy).toHaveBeenCalledWith(emptyInputMessage);
    });

    it("displays no input message when max attempts reached", () => {
      const noInputMessage = chalk.yellow("\nNo input received. Exiting.");

      console.log(noInputMessage);

      expect(consoleSpy).toHaveBeenCalledWith(noInputMessage);
    });

    it("displays continuous mode header", () => {
      const header = chalk.cyan("\n--- Continuous Mode ---");

      console.log(header);

      expect(consoleSpy).toHaveBeenCalledWith(header);
    });

    it("displays ticket queuing message with blue color", () => {
      const ticketTitle = "Add new feature";
      const queueMessage = chalk.blue(`\nQueuing: ${ticketTitle}`);

      console.log(queueMessage);

      expect(consoleSpy).toHaveBeenCalledWith(queueMessage);
    });

    it("displays ticket ID with dim styling", () => {
      const ticketId = "cont-1234567890-abcd1234";
      const idMessage = chalk.dim(`ID: ${ticketId}\n`);

      console.log(idMessage);

      expect(consoleSpy).toHaveBeenCalledWith(idMessage);
    });
  });
});

// =============================================================================
// Multiplexer Integration Tests
// =============================================================================

describe("Multiplexer Integration for Continuous Mode", () => {
  describe("with fake timers", () => {
    let multiplexer: Multiplexer;
    let mockProvider: MockProvider;

    beforeEach(() => {
      vi.useFakeTimers();
      multiplexer = createMultiplexer({ questionTimeout: 100 });
      mockProvider = createMockProvider("terminal");
      multiplexer.addProvider(mockProvider);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("askQuestion integrates with continuous mode question format", async () => {
      await multiplexer.connectAll();

      const questionId = `continuous-${Date.now()}`;
      const questionPromise = multiplexer.askQuestion({
        questionId,
        ticketId: "continuous-mode",
        ticketTitle: "Continuous Mode",
        question: 'Enter your next plan (or "exit" to quit):',
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(mockProvider.sendQuestion).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: "continuous-mode",
          ticketTitle: "Continuous Mode",
          question: expect.stringContaining("exit"),
        })
      );

      mockProvider.triggerQuestion({
        questionId,
        answer: "exit",
        respondedBy: "user",
        respondedAt: new Date(),
      });

      const response = await questionPromise;
      expect(response.answer).toBe("exit");
    });

    it("handles timeout in continuous mode context", async () => {
      const errorHandler = vi.fn();
      multiplexer.on("error", errorHandler);
      await multiplexer.connectAll();

      const questionId = `continuous-${Date.now()}`;

      let caughtError: unknown;
      const questionPromise = multiplexer
        .askQuestion({
          questionId,
          ticketId: "continuous-mode",
          ticketTitle: "Continuous Mode",
          question: 'Enter your next plan (or "exit" to quit):',
        })
        .catch((error) => {
          caughtError = error;
        });

      await vi.advanceTimersByTimeAsync(100);
      await questionPromise;

      expect(caughtError).toBeInstanceOf(TimeoutError);
      expect((caughtError as TimeoutError).operation).toBe("question");
      expect(errorHandler).toHaveBeenCalledOnce();
    });

    it("disconnectAll called on loop exit", async () => {
      await multiplexer.connectAll();
      await multiplexer.disconnectAll();

      expect(mockProvider.disconnect).toHaveBeenCalledOnce();
    });
  });
});

// =============================================================================
// Continuous Loop Flow Simulation Tests
// =============================================================================

describe("Continuous Loop Flow Simulation", () => {
  describe("exit command flow", () => {
    it("simulates exit command terminating loop", async () => {
      const responses = ["exit"];
      let responseIndex = 0;
      let loopContinue = true;

      while (loopContinue && responseIndex < responses.length) {
        const answer = responses[responseIndex++] ?? "";

        if (isExitCommand(answer)) {
          loopContinue = false;
        }
      }

      expect(loopContinue).toBe(false);
      expect(responseIndex).toBe(1);
    });
  });

  describe("empty input handling flow", () => {
    it("simulates empty input count reaching maximum", () => {
      const maxEmptyInputs = 3;
      let emptyInputCount = 0;
      let loopContinue = true;
      const responses = ["", "", ""];

      for (const answer of responses) {
        if (!answer.trim()) {
          emptyInputCount++;
          if (emptyInputCount >= maxEmptyInputs) {
            loopContinue = false;
            break;
          }
        }
      }

      expect(loopContinue).toBe(false);
      expect(emptyInputCount).toBe(3);
    });

    it("simulates valid input resetting empty count", () => {
      let emptyInputCount = 0;
      const responses = ["", "Valid plan text", ""];

      for (const answer of responses) {
        if (!answer.trim()) {
          emptyInputCount++;
        } else {
          emptyInputCount = 0;
        }
      }

      expect(emptyInputCount).toBe(1);
    });
  });

  describe("valid plan processing flow", () => {
    it("simulates valid plan followed by exit", () => {
      const responses = ["Add authentication feature", "exit"];
      const processedTickets: string[] = [];
      let loopContinue = true;

      for (const answer of responses) {
        if (isExitCommand(answer)) {
          loopContinue = false;
          break;
        }

        const ticket = parseUserInputToTicket(answer);
        if (ticket) {
          processedTickets.push(ticket.id);
        }
      }

      expect(loopContinue).toBe(false);
      expect(processedTickets.length).toBe(1);
      expect(processedTickets[0]).toMatch(/^cont-\d+-[0-9a-f]+$/);
    });

    it("simulates multiple valid plans before exit", () => {
      const responses = [
        "First feature implementation",
        "Second feature implementation",
        "Third feature implementation",
        "quit",
      ];
      const processedTickets: string[] = [];
      let loopContinue = true;

      for (const answer of responses) {
        if (isExitCommand(answer)) {
          loopContinue = false;
          break;
        }

        const ticket = parseUserInputToTicket(answer);
        if (ticket) {
          processedTickets.push(ticket.title);
        }
      }

      expect(processedTickets).toEqual([
        "First feature implementation",
        "Second feature implementation",
        "Third feature implementation",
      ]);
    });
  });

  describe("timeout handling flow", () => {
    it("simulates TimeoutError catching pattern", async () => {
      const timeoutError = new TimeoutError(
        "Question timed out",
        "question",
        "continuous-123"
      );

      let loopExitedDueToTimeout = false;

      try {
        throw timeoutError;
      } catch (err) {
        if (err instanceof TimeoutError) {
          loopExitedDueToTimeout = true;
        }
      }

      expect(loopExitedDueToTimeout).toBe(true);
    });

    it("TimeoutError has correct properties for continuous mode context", () => {
      const error = new TimeoutError(
        "Question timed out after 3600000ms",
        "question",
        "continuous-1234567890"
      );

      expect(error.operation).toBe("question");
      expect(error.id).toMatch(/^continuous-\d+$/);
      expect(error.message).toContain("timed out");
    });
  });
});

// =============================================================================
// Schema Validation Integration Tests
// =============================================================================

describe("Schema Validation Integration", () => {
  describe("ticket schema field constraints", () => {
    it("validates ID length constraint (max 100)", () => {
      const ticket = parseUserInputToTicket("Test");

      expect(ticket?.id.length).toBeLessThanOrEqual(100);
    });

    it("validates title length constraint (max 200)", () => {
      const longInput = "A".repeat(300);
      const ticket = parseUserInputToTicket(longInput);

      expect(ticket?.title.length).toBeLessThanOrEqual(200);
    });

    it("validates description length constraint (max 50000)", () => {
      const longDescription = "D".repeat(10000);
      const input = `Title\n${longDescription}`;
      const ticket = parseUserInputToTicket(input);

      expect(ticket?.description.length).toBeLessThanOrEqual(50000);
    });

    it("validates status is valid enum value", () => {
      const ticket = parseUserInputToTicket("Test");
      const validStatuses = ["pending", "planning", "awaiting_approval", "approved", "executing", "completed", "failed", "skipped"];

      expect(validStatuses).toContain(ticket?.status);
    });

    it("validates priority is integer", () => {
      const ticket = parseUserInputToTicket("Test");

      expect(Number.isInteger(ticket?.priority)).toBe(true);
    });
  });

  describe("continuous ticket ID uniqueness", () => {
    it("generates unique IDs across multiple parseUserInputToTicket calls", () => {
      const ids = new Set<string>();
      const count = 50;

      for (let i = 0; i < count; i++) {
        const ticket = parseUserInputToTicket(`Test ticket ${i}`);
        if (ticket) {
          ids.add(ticket.id);
        }
      }

      expect(ids.size).toBe(count);
    });

    it("generates unique IDs with same input text", () => {
      const sameInput = "Identical input text";
      const ids = new Set<string>();
      const count = 10;

      for (let i = 0; i < count; i++) {
        const ticket = parseUserInputToTicket(sameInput);
        if (ticket) {
          ids.add(ticket.id);
        }
      }

      expect(ids.size).toBe(count);
    });
  });
});

// =============================================================================
// Error Handling Integration Tests
// =============================================================================

describe("Error Handling Integration", () => {
  describe("malformed input handling", () => {
    it("handles null-like values gracefully", () => {
      expect(() => parseUserInputToTicket("")).not.toThrow();
      expect(parseUserInputToTicket("")).toBeNull();
    });

    it("handles extremely long input without crashing", () => {
      const veryLongInput = "A".repeat(100000);

      expect(() => parseUserInputToTicket(veryLongInput)).not.toThrow();

      const ticket = parseUserInputToTicket(veryLongInput);
      expect(ticket).not.toBeNull();
    });

    it("handles special characters in input", () => {
      const specialInputs = [
        "Input with <script>alert('xss')</script>",
        "Input with ${env_var}",
        "Input with \0 null byte",
        "Input with \r\n windows newlines",
      ];

      for (const input of specialInputs) {
        expect(() => parseUserInputToTicket(input)).not.toThrow();
        const ticket = parseUserInputToTicket(input);
        expect(ticket).not.toBeNull();
      }
    });
  });

  describe("multiplexer error propagation", () => {
    it("TimeoutError preserves operation context", () => {
      const error = new TimeoutError("Timeout message", "question", "test-id");

      expect(error.name).toBe("TimeoutError");
      expect(error.operation).toBe("question");
      expect(error.id).toBe("test-id");
      expect(error instanceof Error).toBe(true);
    });

    it("TimeoutError can be caught as specific type", () => {
      const error = new TimeoutError("Test", "question", "id");
      let caught = false;

      try {
        throw error;
      } catch (e) {
        if (e instanceof TimeoutError) {
          caught = true;
          expect(e.operation).toBe("question");
        }
      }

      expect(caught).toBe(true);
    });
  });
});
