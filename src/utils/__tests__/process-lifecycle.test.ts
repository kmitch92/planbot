import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendBounded,
  killWithTimeout,
  processRegistry,
  MAX_OUTPUT_CHARS,
} from '../process-lifecycle.js';

describe('appendBounded', () => {
  it('returns combined string when under maxLen', () => {
    const result = appendBounded('hello ', 'world', 20);

    expect(result).toBe('hello world');
  });

  it('truncates to keep last maxLen chars when over limit', () => {
    const result = appendBounded('abcdef', 'ghij', 6);

    expect(result).toHaveLength(6);
    expect(result).toBe('efghij');
  });

  it('returns text when existing is empty', () => {
    const result = appendBounded('', 'new text', 100);

    expect(result).toBe('new text');
  });

  it('returns empty string when both inputs are empty', () => {
    const result = appendBounded('', '', 100);

    expect(result).toBe('');
  });
});

describe('MAX_OUTPUT_CHARS', () => {
  it('equals 50000', () => {
    expect(MAX_OUTPUT_CHARS).toBe(50_000);
  });
});

describe('killWithTimeout', () => {
  let proc: ChildProcess;

  afterEach(async () => {
    try {
      proc?.kill('SIGKILL');
    } catch {
      // already dead
    }
  });

  it('resolves when process exits after SIGTERM', async () => {
    proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });

    await killWithTimeout(proc, 2000);

    expect(proc.killed).toBe(true);
  }, 10_000);

  it('escalates to SIGKILL when process ignores SIGTERM', async () => {
    proc = spawn('sh', ['-c', 'trap "" TERM; sleep 60'], {
      detached: true,
      stdio: 'ignore',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const start = Date.now();
    await killWithTimeout(proc, 500);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(proc.exitCode).not.toBeNull();
  }, 10_000);

  it('resolves immediately if process is already dead', async () => {
    proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    proc.kill('SIGKILL');

    await new Promise((resolve) => proc.on('exit', resolve));

    const start = Date.now();
    await killWithTimeout(proc, 500);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
  }, 10_000);
});

describe('ProcessRegistry', () => {
  let procs: ChildProcess[];

  beforeEach(() => {
    procs = [];
  });

  afterEach(async () => {
    for (const p of procs) {
      try {
        p.kill('SIGKILL');
      } catch {
        // already dead
      }
    }
  });

  it('register adds to active count and auto-decrements on close', async () => {
    const p = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(p);

    processRegistry.register(p, 'test-sleep');

    expect(processRegistry.getActiveCount()).toBeGreaterThanOrEqual(1);

    p.kill('SIGKILL');
    await new Promise((resolve) => p.on('exit', resolve));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processRegistry.getActiveCount()).toBe(0);
  }, 10_000);

  it('killAll terminates all registered processes', async () => {
    const p1 = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const p2 = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(p1, p2);

    processRegistry.register(p1, 'test-p1');
    processRegistry.register(p2, 'test-p2');

    await processRegistry.killAll();

    expect(p1.exitCode).not.toBeNull();
    expect(p2.exitCode).not.toBeNull();
    expect(processRegistry.getActiveCount()).toBe(0);
  }, 10_000);

  it('getActiveCount returns 0 when empty', () => {
    expect(processRegistry.getActiveCount()).toBe(0);
  });

  it('getActivePids returns empty array when no processes registered', () => {
    expect(processRegistry.getActivePids()).toEqual([]);
  });

  it('getActivePids returns PID of registered process', () => {
    const p = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(p);

    processRegistry.register(p, 'test-pid');

    expect(processRegistry.getActivePids()).toContain(p.pid);
  }, 10_000);

  it('getActivePids removes PID after process exits', async () => {
    const p = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(p);

    processRegistry.register(p, 'test-pid-exit');
    const pid = p.pid!;

    p.kill('SIGKILL');
    await new Promise((resolve) => p.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processRegistry.getActivePids()).not.toContain(pid);
  }, 10_000);
});
