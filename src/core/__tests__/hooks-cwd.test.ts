import { describe, it, expect, vi, beforeEach } from "vitest";
import { hookExecutor, type HookContext } from "../hooks.js";
import { evaluateCondition } from "../loop-condition.js";
import type { HookAction, ShellCondition } from "../schemas.js";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// =============================================================================
// Mock Logger
// =============================================================================

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// =============================================================================
// Test Fixtures
// =============================================================================

function createShellAction(command: string, cwd?: string): HookAction {
  return { type: "shell", command, cwd };
}

function createContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    ticketId: "TICKET-001",
    ticketTitle: "Test Ticket",
    ticketStatus: "pending",
    ...overrides,
  };
}

// =============================================================================
// Shell Hook cwd Execution Tests
// =============================================================================

describe("Shell hook cwd execution", () => {
  let tempDir: string;
  let subDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "planbot-test-"));
    subDir = join(tempDir, "nested", "subdir");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "marker.txt"), "found");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("executes shell hook in specified cwd", async () => {
    const action = createShellAction("pwd", subDir);
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output?.trim()).toBe(subDir);
  });

  it("can access files in specified cwd", async () => {
    const action = createShellAction("cat marker.txt", subDir);
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output?.trim()).toBe("found");
  });

  it("uses process cwd when no cwd specified", async () => {
    const action = createShellAction("pwd");
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output?.trim()).toBe(process.cwd());
  });

  it("fails when specified cwd does not exist", async () => {
    const nonExistentDir = join(tempDir, "does-not-exist");
    const action = createShellAction("pwd", nonExistentDir);
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("executes multiple hooks with different cwds", async () => {
    const anotherSubDir = join(tempDir, "another");
    await mkdir(anotherSubDir, { recursive: true });
    await writeFile(join(anotherSubDir, "other.txt"), "other-content");

    const hook = [
      createShellAction("cat marker.txt", subDir),
      createShellAction("cat other.txt", anotherSubDir),
    ];

    const results = await hookExecutor.executeHook(hook, createContext(), {
      allowShellHooks: true,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.output?.trim()).toBe("found");
    expect(results[1]?.success).toBe(true);
    expect(results[1]?.output?.trim()).toBe("other-content");
  });

  it("hook with cwd does not affect subsequent hooks without cwd", async () => {
    const hook = [
      createShellAction("pwd", subDir),
      createShellAction("pwd"),
    ];

    const results = await hookExecutor.executeHook(hook, createContext(), {
      allowShellHooks: true,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.output?.trim()).toBe(subDir);
    expect(results[1]?.output?.trim()).toBe(process.cwd());
  });
});

// =============================================================================
// Loop Condition cwd Execution Tests
// =============================================================================

describe("Loop condition cwd execution", () => {
  let tempDir: string;
  let subDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "planbot-cond-"));
    subDir = join(tempDir, "condition-dir");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "done.txt"), "complete");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("evaluates shell condition in specified cwd", async () => {
    const condition: ShellCondition = {
      type: "shell",
      command: "test -f done.txt",
      cwd: subDir,
    };

    const result = await evaluateCondition(
      condition,
      { ticketId: "test-1", iteration: 0, goal: "test goal" },
      { allowShellHooks: true, cwd: condition.cwd }
    );

    expect(result.met).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("condition fails when file not in cwd", async () => {
    const condition: ShellCondition = {
      type: "shell",
      command: "test -f done.txt",
    };

    const result = await evaluateCondition(
      condition,
      { ticketId: "test-1", iteration: 0, goal: "test goal" },
      { allowShellHooks: true }
    );

    expect(result.met).toBe(false);
  });

  it("captures output from command in cwd", async () => {
    const condition: ShellCondition = {
      type: "shell",
      command: "cat done.txt",
      cwd: subDir,
    };

    const result = await evaluateCondition(
      condition,
      { ticketId: "test-1", iteration: 0, goal: "read file" },
      { allowShellHooks: true, cwd: condition.cwd }
    );

    expect(result.met).toBe(true);
    expect(result.output).toBe("complete");
  });

  it("uses options.cwd for shell condition execution", async () => {
    const condition: ShellCondition = {
      type: "shell",
      command: "pwd",
    };

    const result = await evaluateCondition(
      condition,
      { ticketId: "test-1", iteration: 0, goal: "check cwd" },
      { allowShellHooks: true, cwd: subDir }
    );

    expect(result.met).toBe(true);
    expect(result.output).toBe(subDir);
  });
});

// =============================================================================
// HookContext cwd Field Tests
// =============================================================================

describe("HookContext with cwd information", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "planbot-ctx-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("shell hook receives cwd from action, not context", async () => {
    const action = createShellAction("pwd", tempDir);
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context, {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output?.trim()).toBe(tempDir);
  });

  it("prompt hook ignores cwd (prompt hooks do not spawn processes)", async () => {
    const action: HookAction = {
      type: "prompt",
      command: "Review changes",
    };
    const context = createContext();

    const result = await hookExecutor.executeAction(action, context);

    expect(result.success).toBe(true);
    expect(result.output).toBe("Review changes");
  });
});

// =============================================================================
// Named Hook Execution with cwd
// =============================================================================

describe("Named hook execution with cwd", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "planbot-named-"));
    await writeFile(join(tempDir, "setup-marker.txt"), "setup-done");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("executes named hook with cwd", async () => {
    const hooks = {
      beforeEach: [
        createShellAction("cat setup-marker.txt", tempDir),
      ],
    };

    const results = await hookExecutor.executeNamed(
      hooks,
      "beforeEach",
      createContext(),
      { allowShellHooks: true }
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.output?.trim()).toBe("setup-done");
  });

  it("merged hooks preserve individual cwds", async () => {
    const anotherDir = await mkdtemp(join(tmpdir(), "planbot-merged-"));
    await writeFile(join(anotherDir, "ticket-marker.txt"), "ticket-done");

    const globalHooks = {
      afterEach: [createShellAction("cat setup-marker.txt", tempDir)],
    };

    const ticketHooks = {
      afterEach: [createShellAction("cat ticket-marker.txt", anotherDir)],
    };

    const merged = hookExecutor.mergeHooks(globalHooks, ticketHooks);
    const results = await hookExecutor.executeNamed(
      merged,
      "afterEach",
      createContext(),
      { allowShellHooks: true }
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.output?.trim()).toBe("setup-done");
    expect(results[1]?.output?.trim()).toBe("ticket-done");

    await rm(anotherDir, { recursive: true, force: true });
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("cwd edge cases", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "planbot-edge-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("handles cwd with spaces in path", async () => {
    const dirWithSpaces = join(tempDir, "path with spaces");
    await mkdir(dirWithSpaces, { recursive: true });
    await writeFile(join(dirWithSpaces, "file.txt"), "content");

    const action = createShellAction("cat file.txt", dirWithSpaces);

    const result = await hookExecutor.executeAction(action, createContext(), {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output?.trim()).toBe("content");
  });

  it("handles cwd with special characters in path", async () => {
    const dirWithSpecial = join(tempDir, "path-with_special.chars");
    await mkdir(dirWithSpecial, { recursive: true });
    await writeFile(join(dirWithSpecial, "data.txt"), "special");

    const action = createShellAction("cat data.txt", dirWithSpecial);

    const result = await hookExecutor.executeAction(action, createContext(), {
      allowShellHooks: true,
    });

    expect(result.success).toBe(true);
    expect(result.output?.trim()).toBe("special");
  });

  it("command failure in cwd still returns proper error", async () => {
    const action = createShellAction("exit 42", tempDir);

    const result = await hookExecutor.executeAction(action, createContext(), {
      allowShellHooks: true,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it("shell hook blocked when allowShellHooks is false, regardless of cwd", async () => {
    const action = createShellAction("echo test", tempDir);

    const result = await hookExecutor.executeAction(action, createContext(), {
      allowShellHooks: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
  });
});
