import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionLogReport,
  reportSessionLogSize,
} from "../../utils/session-report.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "planbot-session-report-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("getSessionLogReport", () => {
  it("returns exists=false for missing directory", async () => {
    const missingPath = join(testDir, "nonexistent");

    const report = await getSessionLogReport(missingPath);

    expect(report.exists).toBe(false);
    expect(report.fileCount).toBe(0);
    expect(report.totalSizeMb).toBe(0);
  });

  it("calculates correct size for files in directory", async () => {
    const logsDir = join(testDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const oneKb = "x".repeat(1024);
    await writeFile(join(logsDir, "session-1.log"), oneKb, "utf-8");
    await writeFile(join(logsDir, "session-2.log"), oneKb, "utf-8");

    const report = await getSessionLogReport(logsDir);

    expect(report.exists).toBe(true);
    const expectedMb = (1024 * 2) / (1024 * 1024);
    expect(report.totalSizeMb).toBeCloseTo(expectedMb, 4);
  });

  it("counts files correctly", async () => {
    const logsDir = join(testDir, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, "a.log"), "data", "utf-8");
    await writeFile(join(logsDir, "b.log"), "data", "utf-8");
    await writeFile(join(logsDir, "c.log"), "data", "utf-8");

    const report = await getSessionLogReport(logsDir);

    expect(report.fileCount).toBe(3);
  });
});

describe("reportSessionLogSize", () => {
  it("logs warning when above threshold", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = {
      path: "/tmp/logs",
      totalSizeMb: 150,
      fileCount: 42,
      exists: true,
    };

    reportSessionLogSize(report, 100);

    expect(warnSpy).toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls.flat().join(" ");
    expect(warnMessage).toMatch(/150|warning|threshold|size/i);
    warnSpy.mockRestore();
  });

  it("does not log warning when below threshold", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = {
      path: "/tmp/logs",
      totalSizeMb: 50,
      fileCount: 10,
      exists: true,
    };

    reportSessionLogSize(report, 100);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
