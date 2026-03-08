import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProcessRunning,
  writePidFile,
  removePidFile,
  checkStalePid,
} from "../../utils/pid.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "planbot-pid-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("isProcessRunning", () => {
  it("returns true for current process PID", () => {
    const result = isProcessRunning(process.pid);

    expect(result).toBe(true);
  });

  it("returns false for non-existent PID", () => {
    const result = isProcessRunning(99999999);

    expect(result).toBe(false);
  });
});

describe("writePidFile / removePidFile", () => {
  it("writes current PID and reads it back", async () => {
    const pidPath = join(testDir, "test.pid");

    writePidFile(pidPath);

    const contents = await readFile(pidPath, "utf-8");
    expect(contents.trim()).toBe(String(process.pid));
  });

  it("removePidFile deletes file", async () => {
    const pidPath = join(testDir, "test.pid");
    await writeFile(pidPath, "12345", "utf-8");

    removePidFile(pidPath);

    await expect(readFile(pidPath, "utf-8")).rejects.toThrow();
  });

  it("removePidFile is safe on non-existent file", () => {
    const pidPath = join(testDir, "nonexistent.pid");

    expect(() => removePidFile(pidPath)).not.toThrow();
  });
});

describe("checkStalePid", () => {
  it("returns null when no PID file exists", () => {
    const pidPath = join(testDir, "missing.pid");

    const result = checkStalePid(pidPath);

    expect(result).toBeNull();
  });

  it("returns PID when process is still running", async () => {
    const pidPath = join(testDir, "running.pid");
    await writeFile(pidPath, String(process.pid), "utf-8");

    const result = checkStalePid(pidPath);

    expect(result).toBe(process.pid);
  });

  it("cleans up and returns null when process is dead", async () => {
    const pidPath = join(testDir, "dead.pid");
    const deadPid = 99999999;
    await writeFile(pidPath, String(deadPid), "utf-8");

    const result = checkStalePid(pidPath);

    expect(result).toBeNull();
    await expect(readFile(pidPath, "utf-8")).rejects.toThrow();
  });
});
