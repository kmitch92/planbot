import { readdir, stat } from 'node:fs/promises';
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
