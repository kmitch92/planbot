import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readdir, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maskToken, sanitizeForLogging, Logger } from '../logger.js';

describe('Token Masking', () => {
  describe('maskToken', () => {
    it('masks short tokens completely', () => {
      const result = maskToken('abc');
      expect(result).toBe('***MASKED***');
    });

    it('masks 12-character tokens completely', () => {
      const result = maskToken('abcdefghijkl');
      expect(result).toBe('***MASKED***');
    });

    it('shows first 4 and last 4 characters for long tokens', () => {
      const result = maskToken('xoxb-1234567890abcdef');
      expect(result).toBe('xoxb...cdef');
    });

    it('handles tokens exactly 13 characters', () => {
      const result = maskToken('abcdefghijklm');
      expect(result).toBe('abcd...jklm');
    });

    it('handles very long tokens', () => {
      const token = 'sk-proj-' + 'x'.repeat(100);
      const result = maskToken(token);
      expect(result).toBe('sk-p...xxxx');
    });
  });

  describe('sanitizeForLogging', () => {
    it('masks fields containing "token"', () => {
      const obj = { botToken: 'xoxb-secret123456' };
      const result = sanitizeForLogging(obj);
      expect(result.botToken).toBe('xoxb...3456');
    });

    it('masks fields containing "secret"', () => {
      const obj = { apiSecret: 'mysupersecret' };
      const result = sanitizeForLogging(obj);
      expect(result.apiSecret).toBe('mysu...cret');
    });

    it('masks fields containing "password"', () => {
      const obj = { userPassword: 'pass1234567' };
      const result = sanitizeForLogging(obj);
      expect(result.userPassword).toBe('***MASKED***');
    });

    it('masks fields containing "apikey" (case insensitive)', () => {
      const obj = { apiKey: 'key1234567890' };
      const result = sanitizeForLogging(obj);
      expect(result.apiKey).toBe('key1...7890');
    });

    it('masks fields containing "api_key"', () => {
      const obj = { api_key: 'key1234567890' };
      const result = sanitizeForLogging(obj);
      expect(result.api_key).toBe('key1...7890');
    });

    it('masks "bottoken" field', () => {
      const obj = { bottoken: 'bot1234567890' };
      const result = sanitizeForLogging(obj);
      expect(result.bottoken).toBe('bot1...7890');
    });

    it('masks "apptoken" field', () => {
      const obj = { appToken: 'app1234567890' };
      const result = sanitizeForLogging(obj);
      expect(result.appToken).toBe('app1...7890');
    });

    it('does not mask non-sensitive fields', () => {
      const obj = { username: 'john', email: 'john@example.com' };
      const result = sanitizeForLogging(obj);
      expect(result.username).toBe('john');
      expect(result.email).toBe('john@example.com');
    });

    it('handles mixed sensitive and non-sensitive fields', () => {
      const obj = {
        username: 'alice',
        password: 'pass1234567',
        email: 'alice@example.com',
        apiToken: 'token123456789',
      };
      const result = sanitizeForLogging(obj);
      expect(result.username).toBe('alice');
      expect(result.password).toBe('***MASKED***');
      expect(result.email).toBe('alice@example.com');
      expect(result.apiToken).toBe('toke...6789');
    });

    it('handles non-string values gracefully', () => {
      const obj = { count: 42, enabled: true, data: { nested: 'value' } };
      const result = sanitizeForLogging(obj);
      expect(result.count).toBe(42);
      expect(result.enabled).toBe(true);
      expect(result.data).toEqual({ nested: 'value' });
    });

    it('only masks string values for sensitive keys', () => {
      const obj = { token: 123, secret: false };
      const result = sanitizeForLogging(obj);
      expect(result.token).toBe(123);
      expect(result.secret).toBe(false);
    });
  });
});

describe('Logger.audit', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalLogLevel = process.env.PLANBOT_LOG_LEVEL;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalLogLevel === undefined) {
      delete process.env.PLANBOT_LOG_LEVEL;
    } else {
      process.env.PLANBOT_LOG_LEVEL = originalLogLevel;
    }
  });

  it('outputs message with SECURITY prefix', () => {
    const logger = new Logger();
    logger.audit('Failed auth attempt', { ip: '1.2.3.4' });

    expect(warnSpy).toHaveBeenCalledOnce();
    const output = warnSpy.mock.calls[0][0] as string;
    expect(output).toContain('[SECURITY]');
    expect(output).toContain('Failed auth attempt');
  });

  it('logs even when log level is error', () => {
    process.env.PLANBOT_LOG_LEVEL = 'error';
    const logger = new Logger();

    logger.audit('Unauthorized access');

    expect(warnSpy).toHaveBeenCalledOnce();
    const output = warnSpy.mock.calls[0][0] as string;
    expect(output).toContain('[SECURITY]');
    expect(output).toContain('Unauthorized access');
  });

  it('includes metadata in output', () => {
    const logger = new Logger();
    logger.audit('Rate limited', { ip: '1.2.3.4', endpoint: '/approve' });

    expect(warnSpy).toHaveBeenCalledOnce();
    const output = warnSpy.mock.calls[0][0] as string;
    expect(output).toContain('ip=1.2.3.4');
    expect(output).toContain('endpoint=/approve');
  });
});

describe('cleanupLogs', () => {
  let tempDir: string;
  let testLogger: Logger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'planbot-log-test-'));
    testLogger = new Logger();
  });

  afterEach(async () => {
    await testLogger.disableFileLogging();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns zeros when logDir is null (no file logging enabled)', async () => {
    const result = await testLogger.cleanupLogs();
    expect(result).toEqual({ deletedFiles: 0, freedBytes: 0 });
  });

  it('deletes log files older than maxAgeDays', async () => {
    testLogger.enableFileLogging(tempDir);

    // Create an old log file (10 days ago)
    const oldFile = join(tempDir, 'planbot-2020-01-01.log');
    await writeFile(oldFile, 'old log data here');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, tenDaysAgo, tenDaysAgo);

    // Create a recent log file (1 day ago)
    const recentFile = join(tempDir, 'planbot-2025-12-30.log');
    await writeFile(recentFile, 'recent log data');
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await utimes(recentFile, oneDayAgo, oneDayAgo);

    const result = await testLogger.cleanupLogs({ maxAgeDays: 7 });

    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBe(Buffer.byteLength('old log data here'));

    const remaining = await readdir(tempDir);
    const logFiles = remaining.filter(f => f.startsWith('planbot-') && f.endsWith('.log'));
    // recent file + today's file (created by enableFileLogging)
    expect(logFiles).toContain('planbot-2025-12-30.log');
    expect(logFiles).not.toContain('planbot-2020-01-01.log');
  });

  it('never deletes today\'s log file', async () => {
    testLogger.enableFileLogging(tempDir);

    const today = new Date().toISOString().slice(0, 10);
    const todayFile = join(tempDir, `planbot-${today}.log`);
    // enableFileLogging already creates today's file, but write extra data
    await writeFile(todayFile, 'x'.repeat(1024));

    // Set mtime to far past (should still not be deleted since it's today's filename)
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(todayFile, oldDate, oldDate);

    const result = await testLogger.cleanupLogs({ maxAgeDays: 1 });

    expect(result.deletedFiles).toBe(0);
    const remaining = await readdir(tempDir);
    expect(remaining).toContain(`planbot-${today}.log`);
  });

  it('deletes oldest files first when total size exceeds maxSizeMb', async () => {
    testLogger.enableFileLogging(tempDir);

    // Create files that together exceed the size limit
    const file1 = join(tempDir, 'planbot-2025-12-28.log');
    const file2 = join(tempDir, 'planbot-2025-12-29.log');
    const file3 = join(tempDir, 'planbot-2025-12-30.log');

    const chunkSize = 1024; // 1KB each
    await writeFile(file1, 'a'.repeat(chunkSize));
    await writeFile(file2, 'b'.repeat(chunkSize));
    await writeFile(file3, 'c'.repeat(chunkSize));

    // Set mtimes so file1 is oldest
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await utimes(file1, threeDaysAgo, threeDaysAgo);
    await utimes(file2, twoDaysAgo, twoDaysAgo);
    await utimes(file3, oneDayAgo, oneDayAgo);

    // maxSizeMb tiny enough so oldest gets deleted, maxAgeDays high so phase 1 skips
    // Total is ~3KB + today's file. Set limit to 2KB so oldest gets removed.
    const result = await testLogger.cleanupLogs({ maxAgeDays: 30, maxSizeMb: 2 / 1024 });

    expect(result.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(result.freedBytes).toBeGreaterThanOrEqual(chunkSize);

    const remaining = await readdir(tempDir);
    // Oldest file should be deleted first
    expect(remaining).not.toContain('planbot-2025-12-28.log');
  });

  it('returns correct counts for deletedFiles and freedBytes', async () => {
    testLogger.enableFileLogging(tempDir);

    const file1 = join(tempDir, 'planbot-2024-01-01.log');
    const file2 = join(tempDir, 'planbot-2024-01-02.log');
    const data1 = 'first file content';
    const data2 = 'second file content!!';
    await writeFile(file1, data1);
    await writeFile(file2, data2);

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(file1, oldDate, oldDate);
    await utimes(file2, oldDate, oldDate);

    const result = await testLogger.cleanupLogs({ maxAgeDays: 7 });

    expect(result.deletedFiles).toBe(2);
    expect(result.freedBytes).toBe(Buffer.byteLength(data1) + Buffer.byteLength(data2));
  });
});
