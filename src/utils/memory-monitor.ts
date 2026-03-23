import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { logger } from './logger.js';

export interface ProcessMemoryInfo {
  pid: number;
  rssMb: number;
  command: string;
}

export interface MemorySnapshot {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  openFds: number;
  systemAvailableMb: number;
  childRssMb: number;
  childProcesses: ProcessMemoryInfo[];
  timestamp: string;
}

function getOpenFdCount(): number {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return -1;
  }
}

const round = (n: number): number => +n.toFixed(1);

export function formatSnapshotMeta(snapshot: MemorySnapshot): Record<string, string | number> {
  return {
    rssMb: round(snapshot.rssMb),
    childRssMb: round(snapshot.childRssMb),
    totalRssMb: round(snapshot.rssMb + snapshot.childRssMb),
    heapUsedMb: round(snapshot.heapUsedMb),
    heapTotalMb: round(snapshot.heapTotalMb),
    externalMb: round(snapshot.externalMb),
    systemAvailableMb: round(snapshot.systemAvailableMb),
    openFds: snapshot.openFds,
    topChildProcesses: JSON.stringify(
      snapshot.childProcesses.slice(0, 5).map(p => ({
        pid: p.pid,
        rssMb: round(p.rssMb),
        cmd: p.command,
      }))
    ),
  };
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
    childProcesses: [],
    timestamp: new Date().toISOString(),
  };
}

export function getProcessTreeRss(pids: number[]): number {
  const visited = new Set<number>();
  const queue: number[] = [...pids];
  let totalKb = 0;

  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);

    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) {
        totalKb += Number(match[1]);
      }
    } catch {
      // Process exited or permission error — skip
      continue;
    }

    try {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf-8');
      const childPids = children.trim().split(/\s+/).filter(Boolean).map(Number);
      for (const child of childPids) {
        queue.push(child);
      }
    } catch {
      // No children file — continue
    }
  }

  return totalKb / 1024;
}

/**
 * Walk the process tree for the given root PIDs and return per-process RSS breakdown.
 * Returns array sorted by rssMb descending (biggest consumers first).
 */
export function getProcessTreeBreakdown(pids: number[]): ProcessMemoryInfo[] {
  const visited = new Set<number>();
  const queue: number[] = [...pids];
  const result: ProcessMemoryInfo[] = [];

  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);

    let rssMb = 0;
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) {
        rssMb = Number(match[1]) / 1024;
      }
    } catch {
      continue;
    }

    let command = '<unknown>';
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      command = raw.replace(/\0/g, ' ').trim().slice(0, 80) || '<unknown>';
    } catch {
      // unreadable cmdline
    }

    result.push({ pid, rssMb, command });

    try {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf-8');
      const childPids = children.trim().split(/\s+/).filter(Boolean).map(Number);
      for (const child of childPids) {
        queue.push(child);
      }
    } catch {
      // No children file
    }
  }

  result.sort((a, b) => b.rssMb - a.rssMb);
  return result;
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
          const breakdown = config.getChildPids
            ? getProcessTreeBreakdown(config.getChildPids())
            : [];
          latest.childRssMb = breakdown.reduce((sum, p) => sum + p.rssMb, 0);
          latest.childProcesses = breakdown;
          const totalRss = latest.rssMb + latest.childRssMb;

          const rssCritical = config.criticalMb > 0 && totalRss >= config.criticalMb;
          const systemCritical =
            (config.systemAvailableMinMb ?? 0) > 0 &&
            latest.systemAvailableMb < (config.systemAvailableMinMb ?? 0);

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
