import chalk from 'chalk';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Mask sensitive tokens in strings to prevent accidental logging.
 * Shows first 4 and last 4 characters: "xoxb-1234...5678"
 */
export function maskToken(token: string): string {
  if (token.length <= 12) {
    return '***MASKED***';
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * Sanitize an object for logging by masking fields that look like tokens.
 */
export function sanitizeForLogging(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['token', 'secret', 'password', 'apikey', 'api_key', 'bottoken', 'apptoken'];
  const result: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(k => lowerKey.includes(k)) && typeof value === 'string') {
      result[key] = maskToken(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Log levels ordered by severity
 */
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

/**
 * Context for ticket-aware logging
 */
interface LogContext {
  ticketId?: string;
  phase?: string;
}

/**
 * Additional metadata for log entries
 */
type LogMeta = Record<string, unknown>;

/**
 * Determines the current log level from environment
 */
function getLogLevel(): LogLevel {
  const envLevel = process.env.PLANBOT_LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel as LogLevel;
  }
  return 'info';
}

/**
 * Whether PLANBOT_LOG_LEVEL was explicitly set in environment
 */
function isLogLevelExplicit(): boolean {
  const envLevel = process.env.PLANBOT_LOG_LEVEL?.toLowerCase();
  return !!(envLevel && envLevel in LOG_LEVELS);
}

/**
 * Formats a timestamp for log output
 */
function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Formats context and metadata into a string
 */
function formatContext(ctx: LogContext, meta?: LogMeta): string {
  const parts: string[] = [];

  if (ctx.ticketId) {
    parts.push(`ticket=${ctx.ticketId}`);
  }
  if (ctx.phase) {
    parts.push(`phase=${ctx.phase}`);
  }

  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      const formatted = typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
      parts.push(`${key}=${formatted}`);
    }
  }

  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

/**
 * Color formatters for each log level
 */
const levelFormatters: Record<LogLevel, (text: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
};

/**
 * Level labels for output
 */
const levelLabels: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/**
 * Structured logger with ticket context support
 */
class Logger {
  private context: LogContext = {};
  private minLevel: LogLevel;
  private fileMinLevel: LogLevel;
  private fileStream: WriteStream | null = null;
  private logDir: string | null = null;

  constructor() {
    this.minLevel = getLogLevel();
    this.fileMinLevel = isLogLevelExplicit() ? this.minLevel : 'info';
  }

  /**
   * Set context for subsequent log calls
   */
  setContext(ctx: LogContext): void {
    this.context = { ...this.context, ...ctx };
  }

  /**
   * Clear all context
   */
  clearContext(): void {
    this.context = {};
  }

  /**
   * Get current context
   */
  getContext(): LogContext {
    return { ...this.context };
  }

  /**
   * Enable file logging to the given directory
   */
  enableFileLogging(logDir: string): void {
    mkdirSync(logDir, { recursive: true });
    const filename = `planbot-${new Date().toISOString().slice(0, 10)}.log`;
    this.fileStream = createWriteStream(join(logDir, filename), { flags: 'a' });
    this.logDir = logDir;
  }

  /**
   * Disable file logging and close the stream
   */
  disableFileLogging(): Promise<void> {
    return new Promise((resolve) => {
      if (this.fileStream) {
        const stream = this.fileStream;
        this.fileStream = null;
        this.logDir = null;
        stream.end(() => resolve());
      } else {
        this.logDir = null;
        resolve();
      }
    });
  }

  /**
   * Write a log entry to the file stream as JSON
   */
  private writeToFile(level: string, message: string, meta?: LogMeta): void {
    if (!this.fileStream) return;

    // Check file-specific minimum level (skip for audit which always logs)
    if (level !== 'audit' && level in LOG_LEVELS) {
      const numericLevel = LOG_LEVELS[level as LogLevel];
      if (numericLevel < LOG_LEVELS[this.fileMinLevel]) return;
    }

    // Strip ANSI codes
    const cleanMessage = message.replace(/\u001b\[[0-9;]*m/g, '');

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: cleanMessage,
    };

    if (this.context && Object.keys(this.context).length > 0) {
      entry.context = { ...this.context };
    }

    if (meta) {
      entry.meta = meta;
    }

    this.fileStream.write(JSON.stringify(entry) + '\n');
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  /**
   * Core logging method
   */
  private log(level: LogLevel, message: string, meta?: LogMeta): void {
    this.writeToFile(level, message, meta);

    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = chalk.dim(formatTimestamp());
    const levelLabel = levelFormatters[level](levelLabels[level]);
    const contextStr = formatContext(this.context, meta);
    const output = `${timestamp} ${levelLabel} ${message}${contextStr}`;

    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  /**
   * Debug level log
   */
  debug(message: string, meta?: LogMeta): void {
    this.log('debug', message, meta);
  }

  /**
   * Info level log
   */
  info(message: string, meta?: LogMeta): void {
    this.log('info', message, meta);
  }

  /**
   * Warning level log
   */
  warn(message: string, meta?: LogMeta): void {
    this.log('warn', message, meta);
  }

  /**
   * Error level log
   */
  error(message: string, meta?: LogMeta): void {
    this.log('error', message, meta);
  }

  /**
   * Security audit log — always emitted regardless of log level.
   * Used for authentication failures, authorization rejections, rate limiting, etc.
   */
  audit(message: string, meta?: LogMeta): void {
    const timestamp = chalk.dim(formatTimestamp());
    const securityLabel = chalk.red.bold('[SECURITY]');
    const contextStr = formatContext(this.context, meta);
    const output = `${timestamp} ${securityLabel} ${message}${contextStr}`;
    console.warn(output);
    this.writeToFile('audit', message, meta);
  }

  /**
   * Clean up old log files in the log directory.
   * Phase 1: delete files older than maxAgeDays.
   * Phase 2: if total size exceeds maxSizeMb, delete oldest first (skip today's file).
   */
  async cleanupLogs(options?: { maxAgeDays?: number; maxSizeMb?: number }): Promise<{ deletedFiles: number; freedBytes: number }> {
    const { maxAgeDays = 7, maxSizeMb = 50 } = options ?? {};

    if (!this.logDir) {
      return { deletedFiles: 0, freedBytes: 0 };
    }

    const today = new Date().toISOString().slice(0, 10);
    const todayFilename = `planbot-${today}.log`;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    let entries: string[];
    try {
      entries = (await readdir(this.logDir)).filter(f => f.startsWith('planbot-') && f.endsWith('.log'));
    } catch {
      return { deletedFiles: 0, freedBytes: 0 };
    }

    interface LogFile {
      name: string;
      path: string;
      size: number;
      mtimeMs: number;
    }

    const files: LogFile[] = [];
    for (const name of entries) {
      const path = join(this.logDir, name);
      try {
        const s = await stat(path);
        files.push({ name, path, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        continue;
      }
    }

    let deletedFiles = 0;
    let freedBytes = 0;
    const deletedPaths = new Set<string>();

    // Phase 1: delete files older than maxAgeDays (skip today's file)
    for (const file of files) {
      if (file.name === todayFilename) continue;
      if (now - file.mtimeMs > maxAgeMs) {
        try {
          await unlink(file.path);
          deletedFiles++;
          freedBytes += file.size;
          deletedPaths.add(file.path);
        } catch {
          continue;
        }
      }
    }

    // Phase 2: if total remaining size > maxSizeMb, delete oldest first
    const remaining = files
      .filter(f => !deletedPaths.has(f.path) && f.name !== todayFilename)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalBytes = files
      .filter(f => !deletedPaths.has(f.path))
      .reduce((sum, f) => sum + f.size, 0);

    const maxBytes = maxSizeMb * 1024 * 1024;

    for (const file of remaining) {
      if (totalBytes <= maxBytes) break;
      try {
        await unlink(file.path);
        deletedFiles++;
        freedBytes += file.size;
        totalBytes -= file.size;
      } catch {
        continue;
      }
    }

    return { deletedFiles, freedBytes };
  }
}

/**
 * Default logger instance
 */
export const logger = new Logger();

export type { LogLevel, LogContext, LogMeta };
export { Logger };
