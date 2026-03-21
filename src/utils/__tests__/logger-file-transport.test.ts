import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../logger.js";

let testDir: string;
let loggerInstance: Logger;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "planbot-logger-file-test-"));
  loggerInstance = new Logger();
});

afterEach(async () => {
  if (typeof loggerInstance.disableFileLogging === "function") {
    await loggerInstance.disableFileLogging();
  }
  await rm(testDir, { recursive: true, force: true });
});

function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function expectedLogFilePath(): string {
  return join(testDir, `planbot-${todayDateString()}.log`);
}

async function readLogLines(): Promise<string[]> {
  const content = await readFile(expectedLogFilePath(), "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

async function readParsedLogEntries(): Promise<Array<Record<string, unknown>>> {
  const lines = await readLogLines();
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// =============================================================================
// Disabled by Default
// =============================================================================

describe("file logging disabled by default", () => {
  it("does not create a log file when logging without enableFileLogging", async () => {
    loggerInstance.info("this should only go to console");

    await expect(
      readFile(expectedLogFilePath(), "utf-8")
    ).rejects.toThrow();
  });
});

// =============================================================================
// enableFileLogging / disableFileLogging Lifecycle
// =============================================================================

describe("enableFileLogging", () => {
  it("creates a log file named planbot-YYYY-MM-DD.log in the given directory", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.info("test message");

    await loggerInstance.disableFileLogging();

    const content = await readFile(expectedLogFilePath(), "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("creates the log directory if it does not exist", async () => {
    const nestedDir = join(testDir, "nested", "logs");

    await loggerInstance.enableFileLogging(nestedDir);

    loggerInstance.info("nested dir message");

    await loggerInstance.disableFileLogging();

    const logPath = join(nestedDir, `planbot-${todayDateString()}.log`);
    const content = await readFile(logPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });
});

describe("disableFileLogging", () => {
  it("stops writing to the file after disabling", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.info("before disable");

    await loggerInstance.disableFileLogging();

    loggerInstance.info("after disable");

    const lines = await readLogLines();
    const messages = lines.map(
      (l) => (JSON.parse(l) as Record<string, unknown>).message
    );
    expect(messages).toContain("before disable");
    expect(messages).not.toContain("after disable");
  });

  it("is safe to call when file logging is not enabled", async () => {
    await expect(loggerInstance.disableFileLogging()).resolves.not.toThrow();
  });
});

// =============================================================================
// JSON Line Format
// =============================================================================

describe("file output JSON format", () => {
  it("writes each log entry as a single JSON line", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.info("first message");
    loggerInstance.warn("second message");

    await loggerInstance.disableFileLogging();

    const lines = await readLogLines();
    expect(lines.length).toBe(2);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("includes timestamp, level, and message fields", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.info("structured entry");

    await loggerInstance.disableFileLogging();

    const entries = await readParsedLogEntries();
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("level", "info");
    expect(entry).toHaveProperty("message", "structured entry");
    expect(typeof entry.timestamp).toBe("string");
    expect((entry.timestamp as string).length).toBeGreaterThan(0);
  });

  it("includes context when set on logger", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.setContext({ ticketId: "TICKET-42", phase: "analysis" });
    loggerInstance.info("context entry");

    await loggerInstance.disableFileLogging();

    const entries = await readParsedLogEntries();
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry).toHaveProperty("context");
    const context = entry.context as Record<string, unknown>;
    expect(context.ticketId).toBe("TICKET-42");
    expect(context.phase).toBe("analysis");
  });

  it("includes meta when provided", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.info("meta entry", { userId: "u-123", action: "deploy" });

    await loggerInstance.disableFileLogging();

    const entries = await readParsedLogEntries();
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry).toHaveProperty("meta");
    const meta = entry.meta as Record<string, unknown>;
    expect(meta.userId).toBe("u-123");
    expect(meta.action).toBe("deploy");
  });

  it("writes correct level for each log method", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.debug("d");
    loggerInstance.info("i");
    loggerInstance.warn("w");
    loggerInstance.error("e");

    await loggerInstance.disableFileLogging();

    const entries = await readParsedLogEntries();
    const levels = entries.map((e) => e.level);
    expect(levels).toEqual(["info", "warn", "error"]);
  });
});

// =============================================================================
// Audit Method File Output
// =============================================================================

describe("audit writes to file", () => {
  it("writes audit entries with level audit", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.audit("security event", { ip: "10.0.0.1" });

    await loggerInstance.disableFileLogging();

    const entries = await readParsedLogEntries();
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry).toHaveProperty("level", "audit");
    expect(entry).toHaveProperty("message", "security event");
    expect(entry).toHaveProperty("meta");
    const meta = entry.meta as Record<string, unknown>;
    expect(meta.ip).toBe("10.0.0.1");
  });
});

// =============================================================================
// No ANSI Codes in File Output
// =============================================================================

describe("file output strips ANSI formatting", () => {
  it("does not contain ANSI escape codes in any field", async () => {
    await loggerInstance.enableFileLogging(testDir);

    loggerInstance.setContext({ ticketId: "T-1" });
    loggerInstance.info("clean output", { detail: "value" });
    loggerInstance.error("error output");
    loggerInstance.audit("audit output");

    await loggerInstance.disableFileLogging();

    const content = await readFile(expectedLogFilePath(), "utf-8");
    const ansiPattern = /\u001b\[[0-9;]*m/;
    expect(ansiPattern.test(content)).toBe(false);
  });
});

// =============================================================================
// Append Mode
// =============================================================================

describe("append mode preserves existing content", () => {
  it("does not overwrite log file on subsequent enableFileLogging calls", async () => {
    await loggerInstance.enableFileLogging(testDir);
    loggerInstance.info("first session");
    await loggerInstance.disableFileLogging();

    await loggerInstance.enableFileLogging(testDir);
    loggerInstance.info("second session");
    await loggerInstance.disableFileLogging();

    const entries = await readParsedLogEntries();
    expect(entries).toHaveLength(2);

    const messages = entries.map((e) => e.message);
    expect(messages).toContain("first session");
    expect(messages).toContain("second session");
  });

  it("preserves content from a different logger instance", async () => {
    await loggerInstance.enableFileLogging(testDir);
    loggerInstance.info("instance one");
    await loggerInstance.disableFileLogging();

    const secondLogger = new Logger();
    await secondLogger.enableFileLogging(testDir);
    secondLogger.info("instance two");
    await secondLogger.disableFileLogging();

    const entries = await readParsedLogEntries();
    expect(entries).toHaveLength(2);

    const messages = entries.map((e) => e.message);
    expect(messages).toContain("instance one");
    expect(messages).toContain("instance two");
  });
});

// =============================================================================
// File Logging Respects Log Level for standard methods
// =============================================================================

describe("file logging respects minimum log level", () => {
  it("does not write entries below the configured log level", async () => {
    const savedLevel = process.env.PLANBOT_LOG_LEVEL;
    process.env.PLANBOT_LOG_LEVEL = "warn";

    try {
      const warnLogger = new Logger();
      await warnLogger.enableFileLogging(testDir);

      warnLogger.debug("should be skipped");
      warnLogger.info("should be skipped too");
      warnLogger.warn("should appear");
      warnLogger.error("should also appear");

      await warnLogger.disableFileLogging();

      const entries = await readParsedLogEntries();
      const levels = entries.map((e) => e.level);
      expect(levels).toEqual(["warn", "error"]);
    } finally {
      if (savedLevel === undefined) {
        delete process.env.PLANBOT_LOG_LEVEL;
      } else {
        process.env.PLANBOT_LOG_LEVEL = savedLevel;
      }
    }
  });

  it("always writes audit entries regardless of log level", async () => {
    const savedLevel = process.env.PLANBOT_LOG_LEVEL;
    process.env.PLANBOT_LOG_LEVEL = "error";

    try {
      const errorLogger = new Logger();
      await errorLogger.enableFileLogging(testDir);

      errorLogger.info("filtered out");
      errorLogger.audit("always logged");

      await errorLogger.disableFileLogging();

      const entries = await readParsedLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("audit");
      expect(entries[0].message).toBe("always logged");
    } finally {
      if (savedLevel === undefined) {
        delete process.env.PLANBOT_LOG_LEVEL;
      } else {
        process.env.PLANBOT_LOG_LEVEL = savedLevel;
      }
    }
  });
});
