import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { stateManager } from "../state.js";

describe("State Manager Security - Path Traversal Prevention", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-security-test-"));
    await stateManager.init(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("savePlan() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.savePlan(testDir, "../etc/passwd", "malicious")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("rejects ticketId with forward slash", async () => {
      await expect(
        stateManager.savePlan(testDir, "foo/bar", "content")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("rejects ticketId with backslash", async () => {
      await expect(
        stateManager.savePlan(testDir, "foo\\bar", "content")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("rejects ticketId with null byte", async () => {
      await expect(
        stateManager.savePlan(testDir, "foo\x00bar", "content")
      ).rejects.toThrow(/Invalid ticket ID.*Only alphanumeric/);
    });

    it("allows valid alphanumeric ticketId", async () => {
      await expect(
        stateManager.savePlan(testDir, "TICKET-123", "plan content")
      ).resolves.toBeDefined();
    });

    it("allows ticketId with hyphens and underscores", async () => {
      await expect(
        stateManager.savePlan(testDir, "TICKET_ABC-123", "plan content")
      ).resolves.toBeDefined();
    });
  });

  describe("loadPlan() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.loadPlan(testDir, "../../etc/passwd")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("rejects ticketId with slash", async () => {
      await expect(
        stateManager.loadPlan(testDir, "foo/bar")
      ).rejects.toThrow(/Invalid ticket ID/);
    });
  });

  describe("saveSession() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.saveSession(testDir, "../../../tmp/evil", "session123")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("allows valid ticketId", async () => {
      await expect(
        stateManager.saveSession(testDir, "VALID-TICKET", "session123")
      ).resolves.toBeUndefined();
    });
  });

  describe("loadSession() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.loadSession(testDir, "../../root/.ssh/id_rsa")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });
  });

  describe("appendLog() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.appendLog(testDir, "../malicious", "log entry")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("allows valid ticketId", async () => {
      await expect(
        stateManager.appendLog(testDir, "TICKET-LOG-001", "entry")
      ).resolves.toBeUndefined();
    });
  });
});

describe("State Security - Log Sanitization", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-log-sanitize-test-"));
    await stateManager.init(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("strips ANSI escape sequences from log entries", async () => {
    const { readFile } = await import("node:fs/promises");

    await stateManager.appendLog(
      testDir,
      "SANITIZE-001",
      "Normal text \x1b[31mRED TEXT\x1b[0m end"
    );

    const logPath = join(testDir, ".planbot", "logs", "SANITIZE-001.log");
    const content = await readFile(logPath, "utf-8");

    expect(content).not.toContain("\x1b[31m");
    expect(content).not.toContain("\x1b[0m");
    expect(content).toContain("Normal text");
    expect(content).toContain("end");
  });

  it("strips other control characters from log entries", async () => {
    const { readFile } = await import("node:fs/promises");

    await stateManager.appendLog(
      testDir,
      "SANITIZE-002",
      "Text\x00with\x07control\x08chars"
    );

    const logPath = join(testDir, ".planbot", "logs", "SANITIZE-002.log");
    const content = await readFile(logPath, "utf-8");

    expect(content).not.toContain("\x00");
    expect(content).not.toContain("\x07");
    expect(content).not.toContain("\x08");
    expect(content).toContain("Text");
    expect(content).toContain("chars");
  });

  it("preserves normal text content", async () => {
    const { readFile } = await import("node:fs/promises");

    await stateManager.appendLog(
      testDir,
      "SANITIZE-003",
      "Normal log entry with special chars: !@#$%"
    );

    const logPath = join(testDir, ".planbot", "logs", "SANITIZE-003.log");
    const content = await readFile(logPath, "utf-8");

    expect(content).toContain("Normal log entry with special chars: !@#$%");
  });
});
