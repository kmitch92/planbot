import { describe, it, expect } from 'vitest';
import { maskToken, sanitizeForLogging } from '../logger.js';

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
