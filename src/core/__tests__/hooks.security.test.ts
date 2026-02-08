import { describe, it, expect, vi, beforeEach } from "vitest";
import { hookExecutor, type HookContext } from "../hooks.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Hook Executor Security - Environment Variable Sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects ticketId with null bytes (validation before sanitization)", async () => {
    const action = { type: "shell" as const, command: 'echo "$PLANBOT_TICKET_ID"' };
    const context: HookContext = {
      ticketId: "TICKET\x00malicious",
    };

    // Null byte makes ticketId fail regex validation, so it's rejected
    await expect(
      hookExecutor.executeAction(action, context, { allowShellHooks: true })
    ).rejects.toThrow(/Invalid ticket ID.*Only alphanumeric/);
  });

  it("sanitizes ticketTitle with control characters", async () => {
    const action = { type: "shell" as const, command: 'echo "$PLANBOT_TICKET_TITLE"' };
    const context: HookContext = {
      ticketTitle: "Title\x01\x02\x03",
    };

    const result = await hookExecutor.executeAction(action, context, { allowShellHooks: true });

    expect(result.success).toBe(true);
    expect(result.output).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  });

  it("preserves newlines and tabs in sanitized values", async () => {
    const action = { type: "shell" as const, command: 'echo "$PLANBOT_QUESTION"' };
    const context: HookContext = {
      question: "Question with\nnewline and\ttab",
    };

    const result = await hookExecutor.executeAction(action, context, { allowShellHooks: true });

    expect(result.success).toBe(true);
    // Newlines and tabs should be preserved
    expect(result.output).toContain("newline");
    expect(result.output).toContain("tab");
  });

  it("sanitizes ANSI escape sequences", async () => {
    const action = { type: "shell" as const, command: 'echo "$PLANBOT_ERROR"' };
    const context: HookContext = {
      error: "\x1b[31mRed error\x1b[0m",
    };

    const result = await hookExecutor.executeAction(action, context, { allowShellHooks: true });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain("\x1b");
    expect(result.output).toContain("Red error");
  });

  it("validates ticketId before using in env vars", async () => {
    const action = { type: "shell" as const, command: 'echo "$PLANBOT_TICKET_ID"' };
    const context: HookContext = {
      ticketId: "../../../etc/passwd",
    };

    // Should fail validation before execution
    await expect(
      hookExecutor.executeAction(action, context, { allowShellHooks: true })
    ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
  });

  it("allows valid ticketId", async () => {
    const action = { type: "shell" as const, command: 'echo "$PLANBOT_TICKET_ID"' };
    const context: HookContext = {
      ticketId: "TICKET-123_valid",
    };

    const result = await hookExecutor.executeAction(action, context, { allowShellHooks: true });

    expect(result.success).toBe(true);
    expect(result.output).toContain("TICKET-123_valid");
  });
});

describe("Shell hook environment variable scoping", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("shell hooks receive PLANBOT_* variables from context", async () => {
    const action = { type: "shell" as const, command: "env | grep PLANBOT" };
    const context: HookContext = {
      ticketId: "test-1",
      ticketTitle: "Test ticket",
    };

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("PLANBOT_EVENT=");
    expect(result.output).toContain("PLANBOT_TICKET_ID=test-1");
    expect(result.output).toContain("PLANBOT_TICKET_TITLE=Test ticket");
  });

  it("shell hooks do NOT receive arbitrary process env vars", async () => {
    savedEnv["SECRET_API_KEY"] = process.env["SECRET_API_KEY"];
    process.env["SECRET_API_KEY"] = "leaked";

    const action = { type: "shell" as const, command: 'echo "$SECRET_API_KEY"' };
    const context: HookContext = {
      ticketId: "test-1",
      ticketTitle: "Test ticket",
    };

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output?.trim()).toBe("");
  });

  it("shell hooks receive essential system vars (PATH)", async () => {
    const action = { type: "shell" as const, command: 'echo "$PATH"' };
    const context: HookContext = {
      ticketId: "test-1",
      ticketTitle: "Test ticket",
    };

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output?.trim()).not.toBe("");
    expect(result.output).toContain("/");
  });
});
