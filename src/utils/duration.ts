import { z } from "zod";

const DURATION_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

export const parseDuration = (input: string | number): number => {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0) {
      throw new Error(`Invalid duration: expected non-negative integer, got ${input}`);
    }
    return input;
  }

  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("Invalid duration: empty string");
  }

  const match = DURATION_RE.exec(trimmed);
  if (!match || (!match[1] && !match[2] && !match[3])) {
    throw new Error(`Invalid duration format: "${input}"`);
  }

  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const seconds = match[3] ? parseInt(match[3], 10) : 0;

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
};

export const formatDuration = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds <= 0) return "0s";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.join(" ");
};

export const DurationSchema = z
  .union([z.number().int().nonnegative(), z.string()])
  .transform((val, ctx) => {
    try {
      return parseDuration(val);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof Error ? e.message : String(e),
      });
      return z.NEVER;
    }
  });
