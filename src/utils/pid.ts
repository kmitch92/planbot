import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePidFile(pidPath: string): void {
  writeFileSync(pidPath, String(process.pid), 'utf-8');
}

export function removePidFile(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function checkStalePid(pidPath: string): number | null {
  let content: string;
  try {
    content = readFileSync(pidPath, 'utf-8').trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const pid = parseInt(content, 10);
  if (isNaN(pid)) {
    removePidFile(pidPath);
    return null;
  }

  if (isProcessRunning(pid)) {
    return pid;
  }

  removePidFile(pidPath);
  return null;
}
