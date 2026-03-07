import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

import { createNewCommand } from "../commands/new.js";

describe("new command", () => {
  let testDir: string;
  let originalCwd: () => string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-new-test-"));

    originalCwd = process.cwd;
    process.cwd = () => testDir;

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  const runNew = async (args: string[] = []) => {
    const cmd = createNewCommand();
    await cmd.parseAsync(args, { from: "user" });
  };

  const writeTicketsFile = async (name: string, content: string = "tickets: []") => {
    await writeFile(join(testDir, name), content, "utf-8");
  };

  const fileExistsInTestDir = async (name: string): Promise<boolean> => {
    try {
      await readFile(join(testDir, name), "utf-8");
      return true;
    } catch {
      return false;
    }
  };

  const readTicketsFile = async (name: string): Promise<string> => {
    return readFile(join(testDir, name), "utf-8");
  };

  describe("creates tickets.yaml when no tickets files exist", () => {
    it("creates tickets.yaml in empty directory", async () => {
      await runNew();

      const exists = await fileExistsInTestDir("tickets.yaml");
      expect(exists).toBe(true);
    });

    it("outputs the created filename", async () => {
      await runNew();

      const logCalls = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logCalls).toContain("tickets.yaml");
    });
  });

  describe("creates tickets-1.yaml when tickets.yaml exists", () => {
    it("creates tickets-1.yaml when tickets.yaml exists", async () => {
      await writeTicketsFile("tickets.yaml");

      await runNew();

      const exists = await fileExistsInTestDir("tickets-1.yaml");
      expect(exists).toBe(true);
    });

    it("does not modify existing tickets.yaml", async () => {
      const originalContent = "tickets:\n  - id: existing\n    title: Existing";
      await writeTicketsFile("tickets.yaml", originalContent);

      await runNew();

      const content = await readTicketsFile("tickets.yaml");
      expect(content).toBe(originalContent);
    });

    it("outputs tickets-1.yaml as the created filename", async () => {
      await writeTicketsFile("tickets.yaml");

      await runNew();

      const logCalls = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logCalls).toContain("tickets-1.yaml");
    });
  });

  describe("creates tickets-2.yaml when tickets.yaml and tickets-1.yaml exist", () => {
    it("creates tickets-2.yaml with two existing files", async () => {
      await writeTicketsFile("tickets.yaml");
      await writeTicketsFile("tickets-1.yaml");

      await runNew();

      const exists = await fileExistsInTestDir("tickets-2.yaml");
      expect(exists).toBe(true);
    });

    it("outputs tickets-2.yaml as the created filename", async () => {
      await writeTicketsFile("tickets.yaml");
      await writeTicketsFile("tickets-1.yaml");

      await runNew();

      const logCalls = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logCalls).toContain("tickets-2.yaml");
    });
  });

  describe("handles gaps in numbering", () => {
    it("creates tickets-4.yaml when tickets.yaml and tickets-3.yaml exist", async () => {
      await writeTicketsFile("tickets.yaml");
      await writeTicketsFile("tickets-3.yaml");

      await runNew();

      const exists = await fileExistsInTestDir("tickets-4.yaml");
      expect(exists).toBe(true);
    });

    it("finds highest N and creates N+1 with multiple gaps", async () => {
      await writeTicketsFile("tickets.yaml");
      await writeTicketsFile("tickets-1.yaml");
      await writeTicketsFile("tickets-5.yaml");
      await writeTicketsFile("tickets-10.yaml");

      await runNew();

      const exists = await fileExistsInTestDir("tickets-11.yaml");
      expect(exists).toBe(true);
    });

    it("outputs the correct filename with gaps", async () => {
      await writeTicketsFile("tickets.yaml");
      await writeTicketsFile("tickets-7.yaml");

      await runNew();

      const logCalls = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logCalls).toContain("tickets-8.yaml");
    });
  });

  describe("uses BASIC_TEMPLATE with --simple flag", () => {
    it("creates file with basic template when --simple is passed", async () => {
      await runNew(["--simple"]);

      const content = await readTicketsFile("tickets.yaml");
      expect(content).toContain("tickets:");
      expect(content).toContain("id: example-001");
      expect(content).not.toContain("hooks:");
    });

    it("creates file with advanced template when --simple is not passed", async () => {
      await runNew();

      const content = await readTicketsFile("tickets.yaml");
      expect(content).toContain("tickets:");
      expect(content).toContain("hooks:");
    });
  });

  describe("ignores non-tickets yaml files", () => {
    it("ignores other yaml files when determining next number", async () => {
      await writeTicketsFile("config.yaml");
      await writeTicketsFile("settings.yaml");
      await writeTicketsFile("other-tickets.yaml");

      await runNew();

      const exists = await fileExistsInTestDir("tickets.yaml");
      expect(exists).toBe(true);
    });

    it("only considers tickets*.yaml pattern for numbering", async () => {
      await writeTicketsFile("tickets.yaml");
      await writeTicketsFile("mytickets-1.yaml");
      await writeTicketsFile("tickets-backup.yaml");

      await runNew();

      const exists = await fileExistsInTestDir("tickets-1.yaml");
      expect(exists).toBe(true);
    });
  });

  describe("does not modify .planbot directory", () => {
    it("does not create .planbot directory", async () => {
      await runNew();

      const exists = await fileExistsInTestDir(".planbot");
      expect(exists).toBe(false);
    });
  });

  describe("returns the created filename", () => {
    it("outputs created filename to console", async () => {
      await runNew();

      expect(consoleLogSpy).toHaveBeenCalled();
      const allOutput = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allOutput).toMatch(/tickets(-\d+)?\.yaml/);
    });
  });
});
