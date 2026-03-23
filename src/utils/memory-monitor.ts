import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { logger } from './logger.js';

export interface MemorySnapshot {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  openFds: number;
  systemAvailableMb: number;
  childRssMb: number;
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
    systemAvailableMb: os.freemem() / (1024 * 1024),
    childRssMb: 0,
    timestamp: new Date().toISOString(),
  };
}

export function getProcessTreeRss(pids: number[]): number {
  let totalMb = 0;
  for (const pid of pids) {
    try {
      const content = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const match = content.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) {
        totalMb += Number(match[1]) / 1024;
      }
    } catch {
      // Non-existent pid or permission error — skip
    }
  }
  return totalMb;
}

export function tryGarbageCollect(): boolean {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return true;
  }
  return false;
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

export interface MemoryMonitorConfig {
  intervalSec: number;
  warningMb: number;
  criticalMb: number;
  onWarning: (snapshot: MemorySnapshot) => void;
  onCritical: (snapshot: MemorySnapshot) => void;
  getChildPids?: () => number[];
  systemAvailableMinMb?: number;
}

export interface MemoryMonitor {
  start(config: MemoryMonitorConfig): void;
  start(
    intervalSec: number,
    ceilingMb: number,
    onCeilingHit: (snapshot: MemorySnapshot) => void,
  ): void;
  stop(): void;
  isAboveCeiling(): boolean;
  isAboveWarning(): boolean;
  getLatest(): MemorySnapshot | null;
}

export function createMemoryMonitor(): MemoryMonitor {
  let intervalId: NodeJS.Timeout | null = null;
  let warningMb = 0;
  let latest: MemorySnapshot | null = null;

  return {
    start(
      configOrInterval: MemoryMonitorConfig | number,
      ceiling?: number,
      onCeilingHit?: (snapshot: MemorySnapshot) => void,
    ) {
      if (typeof configOrInterval === 'number') {
        // Legacy path
        const legacyCeiling = ceiling ?? 0;
        warningMb = legacyCeiling;

        const check = () => {
          latest = getMemorySnapshot();
          if (legacyCeiling > 0 && latest.rssMb >= legacyCeiling) {
            onCeilingHit?.(latest);
          }
          if (latest.openFds > 500) {
            logger.warn('High FD count detected', { openFds: latest.openFds });
          }
        };

        check();
        intervalId = setInterval(check, configOrInterval * 1000);
        intervalId.unref();
      } else {
        // New config path
        const config = configOrInterval;
        warningMb = config.warningMb;

        const check = () => {
          latest = getMemorySnapshot();
          const childRss = config.getChildPids
            ? getProcessTreeRss(config.getChildPids())
            : 0;
          latest.childRssMb = childRss;
          const totalRss = latest.rssMb + childRss;

          const rssCritical = config.criticalMb > 0 && totalRss >= config.criticalMb;
          const systemCritical =
            config.systemAvailableMinMb > 0 &&
            latest.systemAvailableMb < config.systemAvailableMinMb;

          if (rssCritical || systemCritical) {
            config.onCritical(latest);
          } else if (config.warningMb > 0 && totalRss >= config.warningMb) {
            config.onWarning(latest);
          }

          if (latest.openFds > 500) {
            logger.warn('High FD count detected', { openFds: latest.openFds });
          }
        };

        check();
        intervalId = setInterval(check, config.intervalSec * 1000);
        intervalId.unref();
      }
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    isAboveWarning() {
      latest = getMemorySnapshot();
      if (warningMb <= 0) return false;
      return latest.rssMb >= warningMb;
    },
    isAboveCeiling() {
      return this.isAboveWarning();
    },
    getLatest() {
      return latest;
    },
  };
}
