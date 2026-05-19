import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { stateManager, getDebriefPath } from "../state.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("PlanbotPaths debriefs field", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-debriefs-paths-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("getPaths() includes debriefs field pointing to .planbot/debriefs", () => {
    const paths = stateManager.getPaths(testDir);

    expect(paths.debriefs).toBe(join(testDir, ".planbot", "debriefs"));
  });

  it("getPaths().debriefs is anchored under .planbot/", () => {
    const paths = stateManager.getPaths(testDir);

    expect(paths.debriefs.startsWith(paths.root)).toBe(true);
  });
});

describe("init() creates debriefs directory", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-debriefs-init-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("creates .planbot/debriefs/ directory on init", async () => {
    await stateManager.init(testDir);

    const paths = stateManager.getPaths(testDir);
    await expect(access(paths.debriefs)).resolves.toBeUndefined();
  });

  it("still creates pre-existing directories (plans, questions, sessions, assets, logs)", async () => {
    await stateManager.init(testDir);

    const paths = stateManager.getPaths(testDir);

    await expect(access(paths.plans)).resolves.toBeUndefined();
    await expect(access(paths.questions)).resolves.toBeUndefined();
    await expect(access(paths.sessions)).resolves.toBeUndefined();
    await expect(access(paths.assets)).resolves.toBeUndefined();
    await expect(access(paths.logs)).resolves.toBeUndefined();
  });

  it("creates debriefs directory alongside the existing tree", async () => {
    await stateManager.init(testDir);

    const paths = stateManager.getPaths(testDir);

    await expect(access(paths.root)).resolves.toBeUndefined();
    await expect(access(paths.debriefs)).resolves.toBeUndefined();
  });
});

describe("getDebriefPath()", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-debriefs-helper-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("valid ticket IDs", () => {
    it("returns .planbot/debriefs/<ticketId>.md for hyphenated id", () => {
      const result = getDebriefPath(testDir, "ticket-1");

      expect(result).toBe(join(testDir, ".planbot", "debriefs", "ticket-1.md"));
    });

    it("accepts underscores and mixed case", () => {
      const result = getDebriefPath(testDir, "abc_DEF");

      expect(result).toBe(join(testDir, ".planbot", "debriefs", "abc_DEF.md"));
    });

    it("accepts purely numeric ids", () => {
      const result = getDebriefPath(testDir, "123");

      expect(result).toBe(join(testDir, ".planbot", "debriefs", "123.md"));
    });

    it("accepts uppercase ticket ids like TICKET-456", () => {
      const result = getDebriefPath(testDir, "TICKET-456");

      expect(result).toBe(
        join(testDir, ".planbot", "debriefs", "TICKET-456.md"),
      );
    });
  });

  describe("path traversal prevention", () => {
    it("rejects ticketId containing ..", () => {
      expect(() => getDebriefPath(testDir, "../etc/passwd")).toThrow(
        /Invalid ticket ID.*Path traversal not allowed/,
      );
    });

    it("rejects ticketId containing forward slash", () => {
      expect(() => getDebriefPath(testDir, "foo/bar")).toThrow(
        /Invalid ticket ID.*Path traversal not allowed/,
      );
    });

    it("rejects ticketId containing backslash", () => {
      expect(() => getDebriefPath(testDir, "foo\\bar")).toThrow(
        /Invalid ticket ID.*Path traversal not allowed/,
      );
    });

    it("rejects parent-relative ticketId like ../../something", () => {
      expect(() => getDebriefPath(testDir, "../../something")).toThrow(
        /Invalid ticket ID.*Path traversal not allowed/,
      );
    });
  });

  describe("invalid character handling", () => {
    it("rejects ticketId containing spaces", () => {
      expect(() => getDebriefPath(testDir, "ticket 1")).toThrow(
        /Invalid ticket ID.*Only alphanumeric/,
      );
    });

    it("rejects ticketId containing exclamation mark", () => {
      expect(() => getDebriefPath(testDir, "ticket!")).toThrow(
        /Invalid ticket ID.*Only alphanumeric/,
      );
    });

    it("rejects ticketId containing asterisk", () => {
      expect(() => getDebriefPath(testDir, "ticket*")).toThrow(
        /Invalid ticket ID.*Only alphanumeric/,
      );
    });

    it("rejects ticketId containing null byte", () => {
      expect(() => getDebriefPath(testDir, "foo\x00bar")).toThrow(
        /Invalid ticket ID.*Only alphanumeric/,
      );
    });

    it("rejects empty string ticketId", () => {
      expect(() => getDebriefPath(testDir, "")).toThrow(/Invalid ticket ID/);
    });
  });
});
