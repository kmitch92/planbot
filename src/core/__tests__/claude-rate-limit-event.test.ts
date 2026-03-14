import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";
import {
  claude,
  type StreamEvent,
  type ExecutionCallbacks,
  getLastRateLimitResetsAt,
  clearRateLimitResetsAt,
} from "../claude.js";

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

// =============================================================================
// Fixtures
// =============================================================================

const RATE_LIMIT_EVENT_LINE = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1773529200,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
  },
});

const RESULT_EVENT_LINE = JSON.stringify({
  type: "result",
  result: "Done",
  cost_usd: 0.01,
  session_id: "sess-rate-limit",
});

const ASSISTANT_EVENT_LINE = JSON.stringify({
  type: "assistant",
  message: "Working on it",
});

// =============================================================================
// Rate Limit Event Parsing via execute() onEvent callback
// =============================================================================

describe("Claude Wrapper - Rate Limit Event Parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRateLimitResetsAt();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers rate_limit event through onEvent callback with full rateLimitInfo", async () => {
    const events: StreamEvent[] = [];
    const mockProc = createMockProcess({
      stdout: [
        RATE_LIMIT_EVENT_LINE + "\n",
        RESULT_EVENT_LINE + "\n",
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

    const rateLimitEvents = events.filter((e) => e.type === "rate_limit");
    expect(rateLimitEvents).toHaveLength(1);
    expect(rateLimitEvents[0]?.rateLimitInfo).toEqual({
      status: "allowed",
      resetsAt: 1773529200,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
      isUsingOverage: false,
    });
  });

  it("ignores rate_limit_event when rate_limit_info is missing", async () => {
    const events: StreamEvent[] = [];
    const malformedRateLimitLine = JSON.stringify({
      type: "rate_limit_event",
    });

    const mockProc = createMockProcess({
      stdout: [
        malformedRateLimitLine + "\n",
        RESULT_EVENT_LINE + "\n",
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

    const rateLimitEvents = events.filter((e) => e.type === "rate_limit");
    expect(rateLimitEvents).toHaveLength(0);
  });

  it("does not interfere with normal event processing", async () => {
    const events: StreamEvent[] = [];
    const mockProc = createMockProcess({
      stdout: [
        ASSISTANT_EVENT_LINE + "\n",
        RATE_LIMIT_EVENT_LINE + "\n",
        RESULT_EVENT_LINE + "\n",
      ],
      exitCode: 0,
      closeDelay: 50,
    });
    mockSpawn.mockReturnValue(mockProc);

    const callbacks: ExecutionCallbacks = {
      onEvent: (event) => events.push(event),
    };

    const result = await claude.execute("Do work", {}, callbacks);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("assistant");
    expect(eventTypes).toContain("rate_limit");
    expect(eventTypes).toContain("result");
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sess-rate-limit");
  });
});

// =============================================================================
// Module-Level Rate Limit State (getters/setters)
// =============================================================================

describe("Claude Wrapper - Rate Limit State Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRateLimitResetsAt();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getLastRateLimitResetsAt returns null initially", () => {
    expect(getLastRateLimitResetsAt()).toBeNull();
  });

  it("stores resetsAt value after processing rate_limit_event via streaming", async () => {
    const mockProc = createMockProcess({
      stdout: [
        RATE_LIMIT_EVENT_LINE + "\n",
        RESULT_EVENT_LINE + "\n",
      ],
      exitCode: 0,
      closeDelay: 50,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.execute("Do work", {}, {});

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(getLastRateLimitResetsAt()).toBe(1773529200);
  });

  it("clearRateLimitResetsAt resets to null", async () => {
    const mockProc = createMockProcess({
      stdout: [
        RATE_LIMIT_EVENT_LINE + "\n",
        RESULT_EVENT_LINE + "\n",
      ],
      exitCode: 0,
      closeDelay: 50,
    });
    mockSpawn.mockReturnValue(mockProc);

    await claude.execute("Do work", {}, {});

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(getLastRateLimitResetsAt()).toBe(1773529200);

    clearRateLimitResetsAt();

    expect(getLastRateLimitResetsAt()).toBeNull();
  });
});
