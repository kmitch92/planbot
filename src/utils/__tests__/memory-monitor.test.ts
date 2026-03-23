import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getMemorySnapshot,
  createMemoryMonitor,
  getDiskSnapshot,
  getProcessTreeRss,
  tryGarbageCollect,
  formatSnapshotMeta,
} from '../memory-monitor.js';
import type { MemorySnapshot } from '../memory-monitor.js';

describe('formatSnapshotMeta', () => {
  const snapshot: MemorySnapshot = {
    rssMb: 93.567,
    childRssMb: 412.234,
    heapUsedMb: 45.678,
    heapTotalMb: 128.999,
    externalMb: 2.345,
    systemAvailableMb: 3500.123,
    openFds: 42,
    timestamp: '2026-03-23T00:00:00.000Z',
  };

  it('returns all expected keys', () => {
    const meta = formatSnapshotMeta(snapshot);

    expect(Object.keys(meta).sort()).toEqual([
      'childRssMb',
      'externalMb',
      'heapTotalMb',
      'heapUsedMb',
      'openFds',
      'rssMb',
      'systemAvailableMb',
      'totalRssMb',
    ]);
  });

  it('rounds numeric values to 1 decimal place', () => {
    const meta = formatSnapshotMeta(snapshot);

    expect(meta.rssMb).toBe(93.6);
    expect(meta.childRssMb).toBe(412.2);
    expect(meta.heapUsedMb).toBe(45.7);
    expect(meta.heapTotalMb).toBe(129.0);
    expect(meta.externalMb).toBe(2.3);
    expect(meta.systemAvailableMb).toBe(3500.1);
  });

  it('computes totalRssMb as rssMb + childRssMb', () => {
    const meta = formatSnapshotMeta(snapshot);

    expect(meta.totalRssMb).toBe(+(93.567 + 412.234).toFixed(1));
  });

  it('passes openFds through as-is (integer)', () => {
    const meta = formatSnapshotMeta(snapshot);

    expect(meta.openFds).toBe(42);
  });
});

describe('getMemorySnapshot', () => {
  it('returns valid positive MB values', () => {
    const snapshot = getMemorySnapshot();

    expect(snapshot.rssMb).toBeGreaterThan(0);
    expect(snapshot.heapUsedMb).toBeGreaterThan(0);
    expect(snapshot.heapTotalMb).toBeGreaterThan(0);
    expect(snapshot.externalMb).toBeGreaterThanOrEqual(0);
  });

  it('returns ISO timestamp', () => {
    const snapshot = getMemorySnapshot();

    expect(typeof snapshot.timestamp).toBe('string');
    const parsed = new Date(snapshot.timestamp);
    expect(parsed.toISOString()).toBe(snapshot.timestamp);
  });
});

describe('getDiskSnapshot', () => {
  it('returns disk stats with expected shape', async () => {
    const snapshot = await getDiskSnapshot('/');

    expect(typeof snapshot.availableMb).toBe('number');
    expect(typeof snapshot.totalMb).toBe('number');
    expect(typeof snapshot.usedPercent).toBe('number');
    expect(typeof snapshot.path).toBe('string');
  });

  it('availableMb and totalMb are positive numbers', async () => {
    const snapshot = await getDiskSnapshot('/');

    expect(snapshot.availableMb).toBeGreaterThan(0);
    expect(snapshot.totalMb).toBeGreaterThan(0);
  });

  it('usedPercent is between 0 and 100', async () => {
    const snapshot = await getDiskSnapshot('/');

    expect(snapshot.usedPercent).toBeGreaterThanOrEqual(0);
    expect(snapshot.usedPercent).toBeLessThanOrEqual(100);
  });

  it('returns the path that was passed in', async () => {
    const snapshot = await getDiskSnapshot('/tmp');

    expect(snapshot.path).toBe('/tmp');
  });
});

describe('createMemoryMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ceiling=0 means disabled and callback never fires', () => {
    const onCeilingHit = vi.fn();
    const monitor = createMemoryMonitor();

    monitor.start(1, 0, onCeilingHit);
    vi.advanceTimersByTime(5_000);
    monitor.stop();

    expect(onCeilingHit).not.toHaveBeenCalled();
  });

  it('triggers callback when RSS exceeds ceiling', () => {
    const onCeilingHit = vi.fn();
    const monitor = createMemoryMonitor();

    monitor.start(1, 1, onCeilingHit);
    vi.advanceTimersByTime(2_000);
    monitor.stop();

    expect(onCeilingHit).toHaveBeenCalled();
    const snapshot = onCeilingHit.mock.calls[0][0];
    expect(snapshot.rssMb).toBeGreaterThan(0);
  });

  it('stop clears the interval', () => {
    const onCeilingHit = vi.fn();
    const monitor = createMemoryMonitor();

    monitor.start(1, 1, onCeilingHit);
    monitor.stop();
    onCeilingHit.mockClear();

    vi.advanceTimersByTime(5_000);

    expect(onCeilingHit).not.toHaveBeenCalled();
  });

  it('isAboveCeiling returns boolean', () => {
    const monitor = createMemoryMonitor();

    monitor.start(60, 1, vi.fn());
    const result = monitor.isAboveCeiling();
    monitor.stop();

    expect(typeof result).toBe('boolean');
  });

  it('getLatest returns snapshot after start', () => {
    const monitor = createMemoryMonitor();

    monitor.start(1, 0, vi.fn());
    vi.advanceTimersByTime(1_000);

    const latest = monitor.getLatest();
    monitor.stop();

    expect(latest).not.toBeNull();
    expect(latest!.rssMb).toBeGreaterThan(0);
    expect(latest!.timestamp).toBeDefined();
  });
});

describe('getProcessTreeRss', () => {
  it('returns 0 for empty pid array', () => {
    const result = getProcessTreeRss([]);

    expect(result).toBe(0);
  });

  it('returns 0 for non-existent pid', () => {
    const result = getProcessTreeRss([999999999]);

    expect(result).toBe(0);
  });

  it('returns positive number for own process pid', () => {
    const result = getProcessTreeRss([process.pid]);

    expect(result).toBeGreaterThan(0);
  });
});


describe('tryGarbageCollect', () => {
  it('returns a boolean', () => {
    const result = tryGarbageCollect();

    expect(typeof result).toBe('boolean');
  });

  it('does not throw', () => {
    expect(() => tryGarbageCollect()).not.toThrow();
  });
});

describe('MemorySnapshot extended fields', () => {
  it('returns systemAvailableMb as a non-negative number', () => {
    const snapshot = getMemorySnapshot();

    expect(typeof snapshot.systemAvailableMb).toBe('number');
    expect(snapshot.systemAvailableMb).toBeGreaterThanOrEqual(0);
  });

  it('returns childRssMb as a number >= 0', () => {
    const snapshot = getMemorySnapshot();

    expect(typeof snapshot.childRssMb).toBe('number');
    expect(snapshot.childRssMb).toBeGreaterThanOrEqual(0);
  });
});

describe('createMemoryMonitor dual-threshold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onWarning when RSS exceeds warning threshold', () => {
    const onWarning = vi.fn();
    const onCritical = vi.fn();
    const monitor = createMemoryMonitor();

    monitor.start({
      intervalSec: 1,
      warningMb: 1,
      criticalMb: 999999,
      onWarning,
      onCritical,
    });
    vi.advanceTimersByTime(2_000);
    monitor.stop();

    expect(onWarning).toHaveBeenCalled();
    const snapshot = onWarning.mock.calls[0][0];
    expect(snapshot.rssMb).toBeGreaterThan(0);
  });

  it('fires onCritical when RSS exceeds critical threshold', () => {
    const onWarning = vi.fn();
    const onCritical = vi.fn();
    const monitor = createMemoryMonitor();

    monitor.start({
      intervalSec: 1,
      warningMb: 1,
      criticalMb: 1,
      onWarning,
      onCritical,
    });
    vi.advanceTimersByTime(2_000);
    monitor.stop();

    expect(onCritical).toHaveBeenCalled();
    const snapshot = onCritical.mock.calls[0][0];
    expect(snapshot.rssMb).toBeGreaterThan(0);
  });

  it('does not fire onCritical when RSS below critical but above warning', () => {
    const onWarning = vi.fn();
    const onCritical = vi.fn();
    const monitor = createMemoryMonitor();

    monitor.start({
      intervalSec: 1,
      warningMb: 1,
      criticalMb: 999999,
      onWarning,
      onCritical,
    });
    vi.advanceTimersByTime(2_000);
    monitor.stop();

    expect(onWarning).toHaveBeenCalled();
    expect(onCritical).not.toHaveBeenCalled();
  });

  it('isAboveWarning returns same result as deprecated isAboveCeiling', () => {
    const monitor = createMemoryMonitor();

    monitor.start({
      intervalSec: 60,
      warningMb: 1,
      criticalMb: 999999,
      onWarning: vi.fn(),
      onCritical: vi.fn(),
    });

    const warningResult = monitor.isAboveWarning();
    const ceilingResult = monitor.isAboveCeiling();
    monitor.stop();

    expect(warningResult).toBe(ceilingResult);
  });

  it('invokes getChildPids callback on each check cycle', () => {
    const getChildPids = vi.fn().mockReturnValue([]);
    const monitor = createMemoryMonitor();

    monitor.start({
      intervalSec: 1,
      warningMb: 999999,
      criticalMb: 999999,
      onWarning: vi.fn(),
      onCritical: vi.fn(),
      getChildPids,
    });
    vi.advanceTimersByTime(3_000);
    monitor.stop();

    expect(getChildPids.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('createMemoryMonitor system-available-memory threshold', () => {
  const realFreemem = vi.hoisted(() => {
    return { value: 0 };
  });

  vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return {
      ...actual,
      default: {
        ...actual,
        freemem: () => realFreemem.value,
      },
    };
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onCritical when system available memory drops below systemAvailableMinMb', async () => {
    realFreemem.value = 1500 * 1024 * 1024;

    const { createMemoryMonitor: createMon } = await import('../memory-monitor.js');
    const onWarning = vi.fn();
    const onCritical = vi.fn();
    const monitor = createMon();

    monitor.start({
      intervalSec: 1,
      warningMb: 999999,
      criticalMb: 999999,
      onWarning,
      onCritical,
      systemAvailableMinMb: 2048,
    });
    vi.advanceTimersByTime(1_000);
    monitor.stop();

    expect(onCritical).toHaveBeenCalled();
  });

  it('does not fire onCritical when system available memory is above systemAvailableMinMb', async () => {
    realFreemem.value = 3000 * 1024 * 1024;

    const { createMemoryMonitor: createMon } = await import('../memory-monitor.js');
    const onWarning = vi.fn();
    const onCritical = vi.fn();
    const monitor = createMon();

    monitor.start({
      intervalSec: 1,
      warningMb: 999999,
      criticalMb: 999999,
      onWarning,
      onCritical,
      systemAvailableMinMb: 2048,
    });
    vi.advanceTimersByTime(1_000);
    monitor.stop();

    expect(onCritical).not.toHaveBeenCalled();
  });

  it('does not fire onCritical for system memory when systemAvailableMinMb is 0 (disabled)', async () => {
    realFreemem.value = 500 * 1024 * 1024;

    const { createMemoryMonitor: createMon } = await import('../memory-monitor.js');
    const onWarning = vi.fn();
    const onCritical = vi.fn();
    const monitor = createMon();

    monitor.start({
      intervalSec: 1,
      warningMb: 999999,
      criticalMb: 999999,
      onWarning,
      onCritical,
      systemAvailableMinMb: 0,
    });
    vi.advanceTimersByTime(1_000);
    monitor.stop();

    expect(onCritical).not.toHaveBeenCalled();
  });

  it('triggers onCritical for low system memory even when RSS is below thresholds', async () => {
    realFreemem.value = 1000 * 1024 * 1024;

    const { createMemoryMonitor: createMon } = await import('../memory-monitor.js');
    const onWarning = vi.fn();
    const onCritical = vi.fn();
    const monitor = createMon();

    monitor.start({
      intervalSec: 1,
      warningMb: 999999,
      criticalMb: 999999,
      onWarning,
      onCritical,
      systemAvailableMinMb: 2048,
    });
    vi.advanceTimersByTime(1_000);
    monitor.stop();

    expect(onCritical).toHaveBeenCalled();
    const snapshot = onCritical.mock.calls[0][0];
    expect(snapshot.systemAvailableMb).toBeLessThan(2048);
  });
});
