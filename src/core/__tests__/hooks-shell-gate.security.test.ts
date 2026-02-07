import { describe, it, expect, vi, beforeEach } from "vitest";
import { hookExecutor, type HookContext } from "../hooks.js";
import type { HookAction, Hooks } from "../schemas.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    ticketId: "TICKET-001",
    ticketTitle: "Test Ticket",
    ticketStatus: "pending",
    ...overrides,
  };
}

// =============================================================================
// Shell Hook Opt-in Gate
// =============================================================================

describe("Shell Hook Opt-in Gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shell hook throws when allowShellHooks is false (default)", async () => {
    const action: HookAction = { type: "shell", command: "echo hello" };
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/shell hooks are disabled/i);
  });

  it("shell hook throws when allowShellHooks is explicitly false", async () => {
    const action: HookAction = { type: "shell", command: "echo hello" };
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/shell hooks are disabled/i);
  });

  it("shell hook executes normally when allowShellHooks is true", async () => {
    const action: HookAction = { type: "shell", command: "echo hello" };
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("prompt hooks always work regardless of allowShellHooks flag", async () => {
    const action: HookAction = { type: "prompt", command: "Some AI prompt" };
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Some AI prompt");
  });

  it("prompt hooks work when allowShellHooks is false", async () => {
    const action: HookAction = { type: "prompt", command: "Some AI prompt" };
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: false,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Some AI prompt");
  });

  it("executeHook propagates allowShellHooks option", async () => {
    const hook = [{ type: "shell" as const, command: "echo test" }];
    const context = createContext();

    const results = await hookExecutor.executeHook(hook, context);

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toMatch(/shell hooks are disabled/i);
  });

  it("executeNamed propagates allowShellHooks option", async () => {
    const hooks: Hooks = {
      beforeAll: [{ type: "shell", command: "echo test" }],
    };
    const context = createContext();

    const results = await hookExecutor.executeNamed(
      hooks,
      "beforeAll",
      context
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toMatch(/shell hooks are disabled/i);
  });
});
