export interface MemorySnapshot {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  timestamp: string;
}

export function getMemorySnapshot(): MemorySnapshot {
  const mem = process.memoryUsage();
  return {
    rssMb: mem.rss / (1024 * 1024),
    heapUsedMb: mem.heapUsed / (1024 * 1024),
    heapTotalMb: mem.heapTotal / (1024 * 1024),
    externalMb: mem.external / (1024 * 1024),
    timestamp: new Date().toISOString(),
  };
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
