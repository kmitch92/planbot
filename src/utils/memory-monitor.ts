import { readdirSync } from 'node:fs';
import { logger } from './logger.js';

export interface MemorySnapshot {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  openFds: number;
  timestamp: string;
}

function getOpenFdCount(): number {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return -1;
  }
}

export function getMemorySnapshot(): MemorySnapshot {
  const mem = process.memoryUsage();
  return {
    rssMb: mem.rss / (1024 * 1024),
    heapUsedMb: mem.heapUsed / (1024 * 1024),
    heapTotalMb: mem.heapTotal / (1024 * 1024),
    externalMb: mem.external / (1024 * 1024),
    openFds: getOpenFdCount(),
    timestamp: new Date().toISOString(),
  };
}

export interface DiskSnapshot {
  availableMb: number;
  totalMb: number;
  usedPercent: number;
  path: string;
}

export async function getDiskSnapshot(path: string): Promise<DiskSnapshot> {
  const { statfs } = await import('node:fs/promises');
  const stats = await statfs(path);
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  const totalMb = totalBytes / (1024 * 1024);
  const availableMb = availableBytes / (1024 * 1024);
  const usedPercent = totalMb > 0 ? ((totalMb - availableMb) / totalMb) * 100 : 0;
  return { availableMb, totalMb, usedPercent, path };
}

export interface MemoryMonitor {
  start(
    intervalSec: number,
    ceilingMb: number,
    onCeilingHit: (snapshot: MemorySnapshot) => void,
  ): void;
  stop(): void;
  isAboveCeiling(): boolean;
  getLatest(): MemorySnapshot | null;
}

export function createMemoryMonitor(): MemoryMonitor {
  let intervalId: NodeJS.Timeout | null = null;
  let ceilingMb = 0;
  let latest: MemorySnapshot | null = null;
  let onHit: ((snapshot: MemorySnapshot) => void) | null = null;

  return {
    start(intervalSec, ceiling, onCeilingHit) {
      ceilingMb = ceiling;
      onHit = onCeilingHit;

      const check = () => {
        latest = getMemorySnapshot();
        if (ceilingMb > 0 && latest.rssMb >= ceilingMb) {
          onHit?.(latest);
        }
        if (latest.openFds > 500) {
          logger.warn('High FD count detected', { openFds: latest.openFds });
        }
      };

      check();
      intervalId = setInterval(check, intervalSec * 1000);
      intervalId.unref();
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    isAboveCeiling() {
      latest = getMemorySnapshot();
      if (ceilingMb <= 0) return false;
      return latest.rssMb >= ceilingMb;
    },
    getLatest() {
      return latest;
    },
  };
}
