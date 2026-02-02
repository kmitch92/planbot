import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readJsonFile,
  writeJsonFile,
  appendToFile,
  ensureDir,
  fileExists,
  readTextFile,
  writeTextFile,
} from "../fs.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "planbot-fs-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// =============================================================================
// readJsonFile Tests
// =============================================================================

describe("readJsonFile", () => {
  it("returns parsed JSON object", async () => {
    const filePath = join(testDir, "object.json");
    const data = { name: "test", count: 42, nested: { value: true } };
    await writeFile(filePath, JSON.stringify(data), "utf-8");

    const result = await readJsonFile<typeof data>(filePath);

    expect(result).toEqual(data);
    expect(result.name).toBe("test");
    expect(result.count).toBe(42);
    expect(result.nested.value).toBe(true);
  });

  it("returns parsed JSON array", async () => {
    const filePath = join(testDir, "array.json");
    const data = [1, "two", { three: 3 }, null];
    await writeFile(filePath, JSON.stringify(data), "utf-8");

    const result = await readJsonFile<typeof data>(filePath);

    expect(result).toEqual(data);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe("two");
    expect(result[2]).toEqual({ three: 3 });
    expect(result[3]).toBeNull();
  });

  it("throws on invalid JSON", async () => {
    const filePath = join(testDir, "invalid.json");
    await writeFile(filePath, "{ not valid json", "utf-8");

    await expect(readJsonFile(filePath)).rejects.toThrow(SyntaxError);
  });

  it("throws on non-existent file", async () => {
    const filePath = join(testDir, "does-not-exist.json");

    await expect(readJsonFile(filePath)).rejects.toThrow();
  });
});

// =============================================================================
// writeJsonFile Tests
// =============================================================================

describe("writeJsonFile", () => {
  it("writes valid JSON with pretty formatting (2-space indent)", async () => {
    const filePath = join(testDir, "output.json");
    const data = { key: "value", nested: { inner: true } };

    await writeJsonFile(filePath, data);

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe(JSON.stringify(data, null, 2));
    expect(content).toContain("\n");
    expect(content).toMatch(/^{\n  "key"/);
  });

  it("creates parent directories if missing", async () => {
    const filePath = join(testDir, "nested", "deep", "dir", "output.json");
    const data = { created: true };

    await writeJsonFile(filePath, data);

    const content = await readFile(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual(data);

    const dirStat = await stat(join(testDir, "nested", "deep", "dir"));
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("performs atomic write (temp file then rename)", async () => {
    const filePath = join(testDir, "atomic.json");
    const data = { atomic: true };

    await writeJsonFile(filePath, data);

    const content = await readFile(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual(data);

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(testDir);
    const tempFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tempFiles).toHaveLength(0);
  });
});

// =============================================================================
// appendToFile Tests
// =============================================================================

describe("appendToFile", () => {
  it("creates file if it does not exist", async () => {
    const filePath = join(testDir, "new-file.txt");
    const content = "first line\n";

    await appendToFile(filePath, content);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe(content);
  });

  it("appends to existing file", async () => {
    const filePath = join(testDir, "existing.txt");
    await writeFile(filePath, "line 1\n", "utf-8");

    await appendToFile(filePath, "line 2\n");

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe("line 1\nline 2\n");
  });

  it("creates parent directories if missing", async () => {
    const filePath = join(testDir, "nested", "path", "append.txt");
    const content = "created with parent dirs\n";

    await appendToFile(filePath, content);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe(content);

    const dirStat = await stat(join(testDir, "nested", "path"));
    expect(dirStat.isDirectory()).toBe(true);
  });
});

// =============================================================================
// ensureDir Tests
// =============================================================================

describe("ensureDir", () => {
  it("creates directory if it does not exist", async () => {
    const dirPath = join(testDir, "new-directory");

    await ensureDir(dirPath);

    const dirStat = await stat(dirPath);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("creates nested directories (recursive)", async () => {
    const dirPath = join(testDir, "a", "b", "c", "d");

    await ensureDir(dirPath);

    const dirStat = await stat(dirPath);
    expect(dirStat.isDirectory()).toBe(true);

    const parentStat = await stat(join(testDir, "a", "b", "c"));
    expect(parentStat.isDirectory()).toBe(true);
  });

  it("is a no-op if directory already exists", async () => {
    const dirPath = join(testDir, "existing-dir");
    await mkdir(dirPath);
    const beforeStat = await stat(dirPath);

    await ensureDir(dirPath);

    const afterStat = await stat(dirPath);
    expect(afterStat.isDirectory()).toBe(true);
    expect(afterStat.ino).toBe(beforeStat.ino);
  });
});

// =============================================================================
// fileExists Tests
// =============================================================================

describe("fileExists", () => {
  it("returns true for existing file", async () => {
    const filePath = join(testDir, "exists.txt");
    await writeFile(filePath, "content", "utf-8");

    const result = await fileExists(filePath);

    expect(result).toBe(true);
  });

  it("returns false for non-existent file", async () => {
    const filePath = join(testDir, "does-not-exist.txt");

    const result = await fileExists(filePath);

    expect(result).toBe(false);
  });

  it("returns true for directory (readable path)", async () => {
    const dirPath = join(testDir, "a-directory");
    await mkdir(dirPath);

    const result = await fileExists(dirPath);

    expect(result).toBe(true);
  });
});

// =============================================================================
// readTextFile / writeTextFile Tests
// =============================================================================

describe("readTextFile", () => {
  it("returns file content as string", async () => {
    const filePath = join(testDir, "text.txt");
    const content = "Hello, World!\nLine 2\n";
    await writeFile(filePath, content, "utf-8");

    const result = await readTextFile(filePath);

    expect(result).toBe(content);
  });

  it("throws on non-existent file", async () => {
    const filePath = join(testDir, "missing.txt");

    await expect(readTextFile(filePath)).rejects.toThrow();
  });
});

describe("writeTextFile", () => {
  it("creates file with content", async () => {
    const filePath = join(testDir, "write-text.txt");
    const content = "Written content\nwith newlines\n";

    await writeTextFile(filePath, content);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe(content);
  });

  it("performs atomic write (no temp files remain)", async () => {
    const filePath = join(testDir, "atomic-text.txt");
    const content = "Atomic content";

    await writeTextFile(filePath, content);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe(content);

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(testDir);
    const tempFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tempFiles).toHaveLength(0);
  });

  it("creates parent directories if missing", async () => {
    const filePath = join(testDir, "deep", "nested", "text.txt");
    const content = "Nested content";

    await writeTextFile(filePath, content);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe(content);

    const dirStat = await stat(join(testDir, "deep", "nested"));
    expect(dirStat.isDirectory()).toBe(true);
  });
});
