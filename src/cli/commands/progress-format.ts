import type { MemorySnapshot } from "../../utils/memory-monitor.js";

/**
 * Format a memory value as MB or GB depending on magnitude.
 * Values >= 1024MB are shown as GB with one decimal place.
 * Values < 1024MB are shown as MB rounded to the nearest integer.
 */
function formatMem(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${Math.round(mb)}MB`;
}

/**
 * Format a MemorySnapshot into a concise string for progress line display.
 *
 * Output format:
 *   mem: 1.6GB (proc: 95MB + children: 1.5GB) | sys avail: 10.3GB
 */
export function formatMemoryInfo(snapshot: MemorySnapshot): string {
  const totalRss = snapshot.rssMb + snapshot.childRssMb;
  const total = formatMem(totalRss);
  const proc = formatMem(snapshot.rssMb);
  const children = formatMem(snapshot.childRssMb);
  const sysAvail = formatMem(snapshot.systemAvailableMb);

  return `mem: ${total} (proc: ${proc} + children: ${children}) | sys avail: ${sysAvail}`;
}
