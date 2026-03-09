import type { ChildProcess } from 'node:child_process';
import { logger } from './logger.js';

export const MAX_OUTPUT_CHARS = 50_000;

/**
 * Append `text` to `existing`, keeping only the last `maxLen` characters.
 */
export function appendBounded(existing: string, text: string, maxLen: number): string {
  const combined = existing + text;
  if (combined.length <= maxLen) return combined;
  return combined.slice(combined.length - maxLen);
}

/**
 * Kill a child process with SIGTERM, escalating to SIGKILL after gracePeriodMs.
 */
export function killWithTimeout(proc: ChildProcess, gracePeriodMs = 5000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const onExit = () => {
      cleanup();
      resolve();
    };

    proc.once('exit', onExit);

    // Send SIGTERM (try process group first)
    sendSignal(proc, 'SIGTERM');

    timer = setTimeout(() => {
      // Escalate to SIGKILL
      sendSignal(proc, 'SIGKILL');
    }, gracePeriodMs);
  });
}

function sendSignal(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // Process already dead
    }
  }
}

export interface ProcessRegistry {
  register(proc: ChildProcess, label: string): void;
  killAll(): Promise<void>;
  getActiveCount(): number;
}

function createProcessRegistry(): ProcessRegistry {
  const active = new Set<ChildProcess>();

  return {
    register(proc: ChildProcess, label: string): void {
      active.add(proc);
      logger.debug('Process registered', { label, pid: proc.pid });

      proc.on('close', () => {
        active.delete(proc);
        logger.debug('Process removed', { label, pid: proc.pid });
      });
    },

    async killAll(): Promise<void> {
      const procs = [...active];
      const promises = procs.map((p) => killWithTimeout(p));
      await Promise.all(promises);
      // All processes have exited; close events may still be pending.
      // Eagerly clear to ensure getActiveCount() reflects reality.
      for (const p of procs) {
        active.delete(p);
      }
    },

    getActiveCount(): number {
      return active.size;
    },
  };
}

export const processRegistry = createProcessRegistry();
