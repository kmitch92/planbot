import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock os.homedir before importing session-report so runStartupCleanup uses temp dirs
const originalHomedir = (await import("node:os")).homedir;
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  return {
    ...actual,
    homedir: vi.fn(actual.homedir),
  };
});

import { homedir } from "node:os";
const mockedHomedir = vi.mocked(homedir);

import {
  getSessionLogReport,
  reportSessionLogSize,
  runStartupCleanup,
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

describe("runStartupCleanup", () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "planbot-startup-cleanup-"));
    mockedHomedir.mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    mockedHomedir.mockReset();
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("does not clean when enabled is false", async () => {
    // Create old files that would normally be cleaned
    const debugDir = join(fakeHome, ".claude", "debug");
    await mkdir(debugDir, { recursive: true });
    await writeFile(join(debugDir, "old.log"), "data");

    await runStartupCleanup({ enabled: false });

    // File should still exist
    const files = await readdir(debugDir);
    expect(files).toContain("old.log");
  });

  it("cleans both debug and projects directories when enabled", async () => {
    // Create debug dir with an old file
    const debugDir = join(fakeHome, ".claude", "debug");
    await mkdir(debugDir, { recursive: true });
    const oldDebugFile = join(debugDir, "old-debug.log");
    await writeFile(oldDebugFile, "x".repeat(1024));
    // Backdate mtime to 5 days ago (exceeds debug's 3-day threshold)
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const { utimes } = await import("node:fs/promises");
    await utimes(oldDebugFile, fiveDaysAgo / 1000, fiveDaysAgo / 1000);

    // Create projects dir with an old file
    const projectsDir = join(fakeHome, ".claude", "projects");
    await mkdir(projectsDir, { recursive: true });
    const oldProjectFile = join(projectsDir, "old-session.log");
    await writeFile(oldProjectFile, "x".repeat(1024));
    // Backdate mtime to 10 days ago (exceeds projects' 7-day threshold)
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await utimes(oldProjectFile, tenDaysAgo / 1000, tenDaysAgo / 1000);

    await runStartupCleanup({ enabled: true });

    // Both old files should be deleted
    const debugFiles = await readdir(debugDir).catch(() => []);
    expect(debugFiles).not.toContain("old-debug.log");

    const projectFiles = await readdir(projectsDir).catch(() => []);
    expect(projectFiles).not.toContain("old-session.log");
  });

  it("catches and logs errors without throwing", async () => {
    // Point homedir at a path that doesn't exist and can't be read
    mockedHomedir.mockReturnValue("/nonexistent-path-for-cleanup-test");

    // Should not throw
    await expect(runStartupCleanup({ enabled: true })).resolves.toBeUndefined();
  });

  it("uses default options when none provided", async () => {
    // Create debug and projects dirs (empty — nothing to clean)
    const debugDir = join(fakeHome, ".claude", "debug");
    const projectsDir = join(fakeHome, ".claude", "projects");
    await mkdir(debugDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });

    // Should run without error using defaults (enabled=true, maxSizeMb=200, maxAgeDays=7)
    await expect(runStartupCleanup()).resolves.toBeUndefined();
  });
});
