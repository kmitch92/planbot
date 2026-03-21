import { readdir, stat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';

export interface SessionLogReport {
  path: string;
  totalSizeMb: number;
  fileCount: number;
  exists: boolean;
}

export async function getSessionLogReport(basePath?: string): Promise<SessionLogReport> {
  const path = basePath ?? join(homedir(), '.claude', 'projects');

  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      return { path, totalSizeMb: 0, fileCount: 0, exists: false };
    }
  } catch {
    return { path, totalSizeMb: 0, fileCount: 0, exists: false };
  }

  let totalBytes = 0;
  let fileCount = 0;

  async function walkDir(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        totalBytes += fileStat.size;
        fileCount++;
      }
    }
  }

  await walkDir(path);

  return {
    path,
    totalSizeMb: totalBytes / (1024 * 1024),
    fileCount,
    exists: true,
  };
}

export interface CleanupResult {
  deletedFiles: number;
  freedMb: number;
}

interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export async function cleanupSessionLogs(options: {
  maxSizeMb?: number;
  maxAgeDays?: number;
  basePath?: string;
  dryRun?: boolean;
} = {}): Promise<CleanupResult> {
  const {
    maxSizeMb = 200,
    maxAgeDays = 7,
    basePath = join(homedir(), '.claude', 'projects'),
    dryRun = false,
  } = options;

  const files: FileEntry[] = [];

  async function collectFiles(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectFiles(fullPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        files.push({ path: fullPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
      }
    }
  }

  await collectFiles(basePath);

  let deletedFiles = 0;
  let freedBytes = 0;
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const deletedPaths = new Set<string>();

  // Phase 1: delete files older than maxAgeDays
  for (const file of files) {
    if (now - file.mtimeMs > maxAgeMs) {
      if (dryRun) {
        logger.info(`[dry-run] Would delete old file: ${file.path}`);
      } else {
        try {
          await unlink(file.path);
          logger.info(`Deleted old session file: ${file.path}`);
        } catch {
          continue;
        }
      }
      deletedPaths.add(file.path);
      deletedFiles++;
      freedBytes += file.size;
    }
  }

  // Phase 2: if still over budget, delete oldest remaining files
  const remaining = files
    .filter(f => !deletedPaths.has(f.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalBytes = remaining.reduce((sum, f) => sum + f.size, 0);
  const maxBytes = maxSizeMb * 1024 * 1024;

  for (const file of remaining) {
    if (totalBytes <= maxBytes) break;
    if (dryRun) {
      logger.info(`[dry-run] Would delete over-budget file: ${file.path}`);
    } else {
      try {
        await unlink(file.path);
        logger.info(`Deleted over-budget session file: ${file.path}`);
      } catch {
        continue;
      }
    }
    deletedPaths.add(file.path);
    deletedFiles++;
    freedBytes += file.size;
    totalBytes -= file.size;
  }

  // Phase 3: remove empty directories
  async function removeEmptyDirs(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await removeEmptyDirs(join(dir, entry.name));
      }
    }
    // Re-read after recursive cleanup
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    if (entries.length === 0 && dir !== basePath) {
      if (dryRun) {
        logger.info(`[dry-run] Would remove empty directory: ${dir}`);
      } else {
        try {
          await rmdir(dir);
          logger.info(`Removed empty directory: ${dir}`);
        } catch {
          // ignore
        }
      }
    }
  }

  await removeEmptyDirs(basePath);

  const freedMb = freedBytes / (1024 * 1024);
  logger.info(`Session cleanup complete: ${deletedFiles} files deleted, ${freedMb.toFixed(1)}MB freed`);

  return { deletedFiles, freedMb };
}

export interface StartupCleanupOptions {
  enabled?: boolean;
  maxSizeMb?: number;
  maxAgeDays?: number;
}

export async function runStartupCleanup(options: StartupCleanupOptions = {}): Promise<void> {
  const { enabled = true, maxSizeMb = 200, maxAgeDays = 7 } = options;

  if (!enabled) {
    logger.debug('Startup cleanup disabled');
    return;
  }

  try {
    // Clean ~/.claude/debug/ (more aggressive: 3 days, 100MB)
    const debugPath = join(homedir(), '.claude', 'debug');
    const debugResult = await cleanupSessionLogs({
      basePath: debugPath,
      maxAgeDays: 3,
      maxSizeMb: 100,
    });
    if (debugResult.deletedFiles > 0) {
      logger.info('Startup debug cleanup', {
        deletedFiles: debugResult.deletedFiles,
        freedMb: debugResult.freedMb.toFixed(1),
      });
    }

    // Clean ~/.claude/projects/ with configured values
    const projectsResult = await cleanupSessionLogs({
      maxAgeDays,
      maxSizeMb,
    });
    if (projectsResult.deletedFiles > 0) {
      logger.info('Startup session cleanup', {
        deletedFiles: projectsResult.deletedFiles,
        freedMb: projectsResult.freedMb.toFixed(1),
      });
    }
  } catch (err) {
    // Non-fatal — log and continue
    logger.warn('Startup cleanup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function reportSessionLogSize(
  report: SessionLogReport,
  warningThresholdMb: number = 500,
): void {
  if (!report.exists) return;

  logger.info(`Session logs: ${report.totalSizeMb.toFixed(1)}MB across ${report.fileCount} files`, {
    path: report.path,
    sizeMb: report.totalSizeMb,
    fileCount: report.fileCount,
  });

  if (report.totalSizeMb > warningThresholdMb) {
    console.warn(`\u26a0 Session logs exceed ${warningThresholdMb}MB (${report.totalSizeMb.toFixed(1)}MB). Consider cleaning: rm -rf ~/.claude/projects/`);
  }
}
