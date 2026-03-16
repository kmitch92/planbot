import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMemorySnapshot, createMemoryMonitor, getDiskSnapshot } from '../memory-monitor.js';

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
