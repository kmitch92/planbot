import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { readFileSync as ReadFileSyncType } from 'node:fs';

const mockReadFileSync = vi.hoisted(() => {
  return { impl: undefined as undefined | ((...args: unknown[]) => unknown) };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof ReadFileSyncType>) => {
      if (mockReadFileSync.impl) {
        return mockReadFileSync.impl(...args);
      }
      return actual.readFileSync(...args);
    },
  };
});

import { getProcessTreeRss } from '../memory-monitor.js';

function makeProcStatus(vmRssKb: number): string {
  return [
    'Name:\tnode',
    'Umask:\t0022',
    'State:\tS (sleeping)',
    `VmRSS:\t${vmRssKb} kB`,
    'Threads:\t1',
  ].join('\n');
}

function buildProcFs(
  tree: Record<number, { vmRssKb: number; children: number[] }>,
): (path: string | URL | number, encoding?: string) => string {
  return (path: string | URL | number) => {
    const pathStr = String(path);

    const statusMatch = pathStr.match(/^\/proc\/(\d+)\/status$/);
    if (statusMatch) {
      const pid = Number(statusMatch[1]);
      const entry = tree[pid];
      if (!entry) {
        const err = new Error(`ENOENT: no such file or directory, open '${pathStr}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return makeProcStatus(entry.vmRssKb);
    }

    const childrenMatch = pathStr.match(/^\/proc\/(\d+)\/task\/\d+\/children$/);
    if (childrenMatch) {
      const pid = Number(childrenMatch[1]);
      const entry = tree[pid];
      if (!entry) {
        const err = new Error(`ENOENT: no such file or directory, open '${pathStr}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return entry.children.length > 0 ? entry.children.join(' ') + '\n' : '';
    }

    const err = new Error(`ENOENT: no such file or directory, open '${pathStr}'`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
}

describe('getProcessTreeRss recursive descendant discovery', () => {
  beforeEach(() => {
    mockReadFileSync.impl = undefined;
  });

  it('includes grandchild RSS in total', () => {
    mockReadFileSync.impl = buildProcFs({
      100: { vmRssKb: 50_000, children: [200] },
      200: { vmRssKb: 100_000, children: [300] },
      300: { vmRssKb: 75_000, children: [] },
    });

    const result = getProcessTreeRss([100]);

    const expectedMb = (50_000 + 100_000 + 75_000) / 1024;
    expect(result).toBeCloseTo(expectedMb, 1);
  });

  it('handles dead grandchild gracefully without throwing', () => {
    mockReadFileSync.impl = buildProcFs({
      100: { vmRssKb: 50_000, children: [200] },
      200: { vmRssKb: 100_000, children: [300] },
    });

    const result = getProcessTreeRss([100]);

    const expectedMb = (50_000 + 100_000) / 1024;
    expect(result).toBeCloseTo(expectedMb, 1);
  });

  it('aggregates multiple root PIDs with separate descendant trees', () => {
    mockReadFileSync.impl = buildProcFs({
      100: { vmRssKb: 50_000, children: [200] },
      200: { vmRssKb: 100_000, children: [] },
      500: { vmRssKb: 80_000, children: [600] },
      600: { vmRssKb: 60_000, children: [] },
    });

    const result = getProcessTreeRss([100, 500]);

    const expectedMb = (50_000 + 100_000 + 80_000 + 60_000) / 1024;
    expect(result).toBeCloseTo(expectedMb, 1);
  });

  it('terminates without infinite loop on circular child references', () => {
    mockReadFileSync.impl = buildProcFs({
      100: { vmRssKb: 50_000, children: [200] },
      200: { vmRssKb: 100_000, children: [100] },
    });

    const result = getProcessTreeRss([100]);

    const expectedMb = (50_000 + 100_000) / 1024;
    expect(result).toBeCloseTo(expectedMb, 1);
  });
});
