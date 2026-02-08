import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
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

import { createAttachCommand } from "../commands/attach.js";

describe("attach command", () => {
  let testDir: string;
  let ticketsPath: string;
  let originalCwd: () => string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-attach-test-"));
    ticketsPath = join(testDir, "tickets.yaml");

    originalCwd = process.cwd;
    process.cwd = () => testDir;

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
    consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => {});
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await mkdir(join(testDir, ".planbot", "assets"), { recursive: true });
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    exitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  const writeTickets = async (content: string) => {
    await writeFile(ticketsPath, content, "utf-8");
  };

  const createTestImage = async (name: string): Promise<string> => {
    const path = join(testDir, name);
    await writeFile(path, "fake-image-content");
    return path;
  };

  const runAttach = async (args: string[]) => {
    const cmd = createAttachCommand();
    await cmd.parseAsync(args, { from: "user" });
  };

  describe("successful attachment", () => {
    it("attaches image to ticket and updates YAML", async () => {
      await writeTickets(
        [
          "tickets:",
          "  - id: fix-bug",
          "    title: Fix Bug",
          "    description: Fix the bug",
        ].join("\n")
      );

      await createTestImage("screenshot.png");

      await runAttach(["fix-bug", "screenshot.png"]);

      const updated = await readFile(ticketsPath, "utf-8");
      expect(updated).toContain("images:");
      expect(updated).toContain(".planbot/assets/fix-bug/screenshot.png");

      const copiedPath = join(
        testDir,
        ".planbot",
        "assets",
        "fix-bug",
        "screenshot.png"
      );
      const content = await readFile(copiedPath, "utf-8");
      expect(content).toBe("fake-image-content");

      const logCalls = consoleLogSpy.mock.calls
        .map((c) => c.join(" "))
        .join("\n");
      expect(logCalls).toContain("Image attached");
    });
  });

  describe("tickets file validation", () => {
    it("exits with error for missing tickets file", async () => {
      await createTestImage("shot.png");

      await expect(
        runAttach(["fix-bug", "shot.png", "-f", "nonexistent.yaml"])
      ).rejects.toThrow("process.exit called");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorCalls = consoleErrorSpy.mock.calls
        .map((c) => c.join(" "))
        .join("\n");
      expect(errorCalls).toContain("not found");
    });
  });

  describe("ticket ID validation", () => {
    it("exits with error for non-existent ticket ID", async () => {
      await writeTickets(
        [
          "tickets:",
          "  - id: real-ticket",
          "    title: Real",
          "    description: Exists",
        ].join("\n")
      );

      await createTestImage("shot.png");

      await expect(
        runAttach(["fake-ticket", "shot.png"])
      ).rejects.toThrow("process.exit called");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorCalls = consoleErrorSpy.mock.calls
        .map((c) => c.join(" "))
        .join("\n");
      expect(errorCalls).toContain("Ticket not found");
    });
  });

  describe("image file validation", () => {
    it("exits with error for missing image file", async () => {
      await writeTickets(
        [
          "tickets:",
          "  - id: fix-bug",
          "    title: Fix Bug",
          "    description: Fix it",
        ].join("\n")
      );

      await expect(
        runAttach(["fix-bug", "nonexistent.png"])
      ).rejects.toThrow("process.exit called");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorCalls = consoleErrorSpy.mock.calls
        .map((c) => c.join(" "))
        .join("\n");
      expect(errorCalls).toContain("not found");
    });

    it("exits with error for unsupported image format", async () => {
      await writeTickets(
        [
          "tickets:",
          "  - id: fix-bug",
          "    title: Fix Bug",
          "    description: Fix it",
        ].join("\n")
      );

      await createTestImage("document.pdf");

      await expect(
        runAttach(["fix-bug", "document.pdf"])
      ).rejects.toThrow("process.exit called");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorCalls = consoleErrorSpy.mock.calls
        .map((c) => c.join(" "))
        .join("\n");
      expect(errorCalls).toContain("Unsupported image format");
    });
  });

  describe("image limit enforcement", () => {
    it("exits with error when image limit is exceeded", async () => {
      const images = Array.from(
        { length: 10 },
        (_, i) => `.planbot/assets/fix-bug/img${i}.png`
      );
      await writeTickets(
        [
          "tickets:",
          "  - id: fix-bug",
          "    title: Fix Bug",
          "    description: Fix it",
          "    images:",
          ...images.map((p) => `      - ${p}`),
        ].join("\n")
      );

      await createTestImage("one-more.png");

      await expect(
        runAttach(["fix-bug", "one-more.png"])
      ).rejects.toThrow("process.exit called");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorCalls = consoleErrorSpy.mock.calls
        .map((c) => c.join(" "))
        .join("\n");
      expect(errorCalls).toContain("10");
    });
  });
});
