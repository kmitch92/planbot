import chalk from 'chalk';

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

  constructor() {
    this.minLevel = getLogLevel();
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
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  /**
   * Core logging method
   */
  private log(level: LogLevel, message: string, meta?: LogMeta): void {
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
  }
}

/**
 * Default logger instance
 */
export const logger = new Logger();

export type { LogLevel, LogContext, LogMeta };
export { Logger };
