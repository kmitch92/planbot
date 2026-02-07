import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";
import { claude, type StreamEvent, type ExecutionCallbacks } from "../claude.js";

// =============================================================================
// Mocks
// =============================================================================

vi.mock("node:child_process");
vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockSpawn = vi.mocked(spawn);

// =============================================================================
// Test Utilities
// =============================================================================

interface MockProcessOptions {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  emitError?: Error;
  closeDelay?: number;
  closeAfterStdout?: number;
}

function createMockProcess(options: MockProcessOptions = {}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;

  const stdinData: string[] = [];
  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinData.push(chunk.toString());
      callback();
    },
  }) as ChildProcess["stdin"];
  (proc.stdin as Writable & { _data: string[] })._data = stdinData;

  proc.stdout = new Readable({
    read() {},
  }) as ChildProcess["stdout"];

  proc.stderr = new Readable({
    read() {},
  }) as ChildProcess["stderr"];

  proc.kill = vi.fn().mockReturnValue(true);
  proc.pid = 12345;

  const delay = options.closeDelay ?? 10;
  const closeAfterStdout = options.closeAfterStdout ?? 50;

  setTimeout(() => {
    if (options.emitError) {
      proc.emit("error", options.emitError);
      return;
    }

    options.stdout?.forEach((line) => {
      proc.stdout!.emit("data", Buffer.from(line));
    });

    options.stderr?.forEach((line) => {
      proc.stderr!.emit("data", Buffer.from(line));
    });

    setTimeout(() => {
      proc.emit("close", options.exitCode ?? 0);
    }, closeAfterStdout);
  }, delay);

  return proc;
}

function getStdinWrites(proc: ChildProcess): string[] {
  return (proc.stdin as Writable & { _data: string[] })._data;
}

// =============================================================================
// Plan Generation Tests
// =============================================================================

describe("Claude Wrapper - Plan Generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns claude with correct args for plan generation", async () => {
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({ type: "assistant", message: "Plan content here" }) + "\n",
        JSON.stringify({ type: "result", result: "", cost_usd: 0.01, session_id: "s1" }) + "\n",
      ],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.generatePlan("Create a feature", { model: "opus" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["--print", "--output-format", "stream-json", "--permission-mode", "plan", "--model", "opus"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] })
    );
  });

  it("writes prompt to stdin", async () => {
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({ type: "assistant", message: "Plan content" }) + "\n",
        JSON.stringify({ type: "result", result: "", cost_usd: 0.01 }) + "\n",
      ],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.generatePlan("Build authentication system");

    const writes = getStdinWrites(mockProc);
    expect(writes.join("")).toContain("Build authentication system");
  });

  it("returns success with plan content on successful exit", async () => {
    const planContent = "## Plan\n\n1. Step one\n2. Step two";
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({ type: "assistant", message: planContent }) + "\n",
        JSON.stringify({ type: "result", result: "", cost_usd: 0.05, session_id: "s1" }) + "\n",
      ],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.generatePlan("Create tests");

    expect(result.success).toBe(true);
    expect(result.plan).toBe(planContent);
    expect(result.costUsd).toBe(0.05);
  });

  it("returns success false on non-zero exit code", async () => {
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({ type: "error", error: "API key invalid" }) + "\n",
      ],
      exitCode: 1,
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.generatePlan("Generate plan");

    expect(result.success).toBe(false);
    expect(result.error).toContain("API key invalid");
  });

  it("returns success false on timeout", async () => {
    const proc = new EventEmitter() as ChildProcess;

    const stdinData: string[] = [];
    proc.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdinData.push(chunk.toString());
        callback();
      },
    }) as ChildProcess["stdin"];
    (proc.stdin as Writable & { _data: string[] })._data = stdinData;

    proc.stdout = new Readable({ read() {} }) as ChildProcess["stdout"];
    proc.stderr = new Readable({ read() {} }) as ChildProcess["stderr"];
    proc.kill = vi.fn().mockImplementation(() => {
      proc.emit("close", 0);
      return true;
    });
    proc.pid = 12345;

    mockSpawn.mockReturnValue(proc);

    const result = await claude.generatePlan("Generate plan", { timeout: 50 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("parses cost_usd from result event", async () => {
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({ type: "assistant", message: "Plan" }) + "\n",
        JSON.stringify({ type: "result", result: "", cost_usd: 0.123, session_id: "s1" }) + "\n",
      ],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.generatePlan("Create plan");

    expect(result.costUsd).toBe(0.123);
  });
});

// =============================================================================
// Streaming Execution Tests
// =============================================================================

describe("Claude Wrapper - Streaming Execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns claude with stream-json format", async () => {
    const mockProc = createMockProcess({
      stdout: [JSON.stringify({ type: "result", result: "Done", session_id: "sess-123" }) + "\n"],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.execute("Do something", { model: "sonnet" }, {});

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        "sonnet",
      ]),
      expect.any(Object)
    );
  });

  it("includes --dangerously-skip-permissions when skipPermissions true", async () => {
    const mockProc = createMockProcess({
      stdout: [JSON.stringify({ type: "result", result: "Done" }) + "\n"],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.execute("Execute task", { skipPermissions: true }, {});

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--dangerously-skip-permissions"]),
      expect.any(Object)
    );
  });

  it("includes --session-id when provided", async () => {
    const mockProc = createMockProcess({
      stdout: [JSON.stringify({ type: "result", result: "Done" }) + "\n"],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.execute("Continue work", { sessionId: "existing-session-456" }, {});

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--session-id", "existing-session-456"]),
      expect.any(Object)
    );
  });

  it("calls onEvent callback for stream events", async () => {
    const events: StreamEvent[] = [];
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({ type: "init", session_id: "new-sess" }) + "\n",
        JSON.stringify({ type: "assistant", message: "Working on it" }) + "\n",
        JSON.stringify({ type: "result", result: "Complete", cost_usd: 0.01 }) + "\n",
      ],
      exitCode: 0,
      closeDelay: 50,
    });
    mockSpawn.mockReturnValue(mockProc);

    const callbacks: ExecutionCallbacks = {
      onEvent: (event) => events.push(event),
    };

    await claude.execute("Do work", {}, callbacks);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("result");
  });

  it("calls onOutput callback with raw output", async () => {
    const outputs: string[] = [];
    const mockProc = createMockProcess({
      stdout: ['{"type":"result","result":"Done"}\n'],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    const callbacks: ExecutionCallbacks = {
      onOutput: (text) => outputs.push(text),
    };

    await claude.execute("Run task", {}, callbacks);

    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.join("")).toContain("result");
  });

  it("returns sessionId from result event", async () => {
    const mockProc = createMockProcess({
      stdout: [JSON.stringify({ type: "result", result: "Done", session_id: "returned-session" }) + "\n"],
      exitCode: 0,
      closeAfterStdout: 100,
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.execute("Task", {}, {});

    expect(result.sessionId).toBe("returned-session");
  });
});

// =============================================================================
// Session Resume Tests
// =============================================================================

describe("Claude Wrapper - Session Resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes --resume flag with session ID", async () => {
    const mockProc = createMockProcess({
      stdout: [JSON.stringify({ type: "result", result: "Resumed" }) + "\n"],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.resume("session-to-resume", "Continue from here", {}, {});

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--resume", "session-to-resume"]),
      expect.any(Object)
    );
  });

  it("sends input as user message", async () => {
    const mockProc = createMockProcess({
      stdout: [JSON.stringify({ type: "result", result: "Done" }) + "\n"],
      exitCode: 0,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.resume("sess-123", "Please continue with step 2", {}, {});

    const writes = getStdinWrites(mockProc);
    const written = writes.join("");
    expect(written).toContain("Please continue with step 2");

    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("Please continue with step 2");
  });

  it("returns execution result", async () => {
    const mockProc = createMockProcess({
      stdout: [JSON.stringify({ type: "result", result: "Complete", cost_usd: 0.02, session_id: "sess-123" }) + "\n"],
      exitCode: 0,
      closeAfterStdout: 100,
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.resume("sess-123", "Continue", {}, {});

    expect(result.success).toBe(true);
    expect(result.costUsd).toBe(0.02);
    expect(result.sessionId).toBe("sess-123");
  });
});

// =============================================================================
// Abort Handling Tests
// =============================================================================

describe("Claude Wrapper - Abort Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kills current process with SIGTERM", async () => {
    const mockProc = createMockProcess({
      closeDelay: 5000,
    });
    mockSpawn.mockReturnValue(mockProc);

    const execPromise = claude.execute("Long task", {}, {});

    await new Promise((resolve) => setTimeout(resolve, 20));

    claude.abort();

    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");

    mockProc.emit("close", 0);
    await execPromise;
  });

  it("no-op when no process running", () => {
    expect(() => claude.abort()).not.toThrow();
  });

  it("answerQuestion writes to process stdin", async () => {
    const mockProc = createMockProcess({
      closeDelay: 200,
    });
    mockSpawn.mockReturnValue(mockProc);

    const execPromise = claude.execute("Interactive task", {}, {});

    await new Promise((resolve) => setTimeout(resolve, 20));

    claude.answerQuestion("Yes, proceed");

    const writes = getStdinWrites(mockProc);
    const allWrites = writes.join("");

    expect(allWrites).toContain("Yes, proceed");

    const answerWrite = writes.find((w) => w.includes("Yes, proceed"));
    if (answerWrite) {
      const parsed = JSON.parse(answerWrite.trim());
      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("Yes, proceed");
    }

    mockProc.emit("close", 0);
    await execPromise;
  });
});

// =============================================================================
// Stream Event Parsing Tests
// =============================================================================

describe("Claude Wrapper - Stream Event Parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses assistant message events", async () => {
    const events: StreamEvent[] = [];
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({ type: "assistant", message: "I will help you with that" }) + "\n",
        JSON.stringify({ type: "result", result: "Done" }) + "\n",
      ],
      exitCode: 0,
      closeDelay: 50,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.execute("Help me", {}, { onEvent: (e) => events.push(e) });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const assistantEvents = events.filter((e) => e.type === "assistant");
    expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
    expect(assistantEvents[0]?.message).toBe("I will help you with that");
  });

  it("parses tool_use events with toolName and toolInput", async () => {
    const events: StreamEvent[] = [];
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({
          type: "tool_use",
          tool_name: "Read",
          tool_input: { file_path: "/path/to/file.ts" },
        }) + "\n",
        JSON.stringify({ type: "result", result: "Done" }) + "\n",
      ],
      exitCode: 0,
      closeDelay: 50,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.execute("Read a file", {}, { onEvent: (e) => events.push(e) });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const toolEvents = events.filter((e) => e.type === "tool_use");
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolEvents[0]?.toolName).toBe("Read");
    expect(toolEvents[0]?.toolInput).toEqual({ file_path: "/path/to/file.ts" });
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe("Claude Wrapper - Error Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles spawn error gracefully for generatePlan", async () => {
    const mockProc = createMockProcess({
      emitError: new Error("ENOENT: claude not found"),
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.generatePlan("Generate plan");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to spawn claude");
  });

  it("handles spawn error gracefully for execute", async () => {
    const mockProc = createMockProcess({
      emitError: new Error("ENOENT: claude not found"),
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.execute("Execute task", {}, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to spawn claude");
  });

  it("handles malformed JSON in stream gracefully", async () => {
    const events: StreamEvent[] = [];
    const mockProc = createMockProcess({
      stdout: [
        "not valid json\n",
        JSON.stringify({ type: "result", result: "Done" }) + "\n",
      ],
      exitCode: 0,
      closeDelay: 10,
      closeAfterStdout: 100,
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.execute("Task", {}, { onEvent: (e) => events.push(e) });

    expect(result.success).toBe(true);
    expect(events.some((e) => e.type === "result")).toBe(true);
  });

  it("handles error event type in stream", async () => {
    const events: StreamEvent[] = [];
    const mockProc = createMockProcess({
      stdout: [
        JSON.stringify({ type: "error", error: "Rate limit exceeded", cost_usd: 0.01 }) + "\n",
      ],
      exitCode: 0,
      closeDelay: 10,
      closeAfterStdout: 100,
    });
    mockSpawn.mockReturnValue(mockProc);

    const result = await claude.execute("Task", {}, { onEvent: (e) => events.push(e) });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Rate limit exceeded");
  });
});
