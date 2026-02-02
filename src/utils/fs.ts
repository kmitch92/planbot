import { mkdir, readFile, writeFile, rename, access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Read and parse a JSON file
 * @throws Error if file doesn't exist or JSON is invalid
 */
export async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * Write data to a JSON file atomically
 * Writes to temp file then renames to prevent partial writes
 */
export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await atomicWrite(path, content);
}

/**
 * Append content to a file, creating it if it doesn't exist
 */
export async function appendToFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  let existing = '';
  try {
    existing = await readFile(path, 'utf-8');
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err;
    }
  }
  await atomicWrite(path, existing + content);
}

/**
 * Ensure a directory exists, creating it and parents if necessary
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Check if a file exists and is readable
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a text file as string
 * @throws Error if file doesn't exist
 */
export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

/**
 * Write text to a file atomically
 * Writes to temp file then renames to prevent partial writes
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await atomicWrite(path, content);
}

/**
 * Perform an atomic write by writing to temp file then renaming
 */
async function atomicWrite(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));

  const tempSuffix = randomBytes(8).toString('hex');
  const tempPath = join(dirname(path), `.${tempSuffix}.tmp`);

  try {
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, path);
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      await access(tempPath);
      const { unlink } = await import('node:fs/promises');
      await unlink(tempPath);
    } catch {
      // Temp file doesn't exist or can't be deleted, ignore
    }
    throw err;
  }
}

/**
 * Type guard for Node.js errors with code property
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
