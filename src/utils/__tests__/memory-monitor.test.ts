import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getMemorySnapshot,
  createMemoryMonitor,
  getProcessTreeRss,
  tryGarbageCollect,
} from '../memory-monitor.js';

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
