import { describe, it, expect } from 'vitest';
import {
  TicketSchema,
  ShellHookActionSchema,
  PromptHookActionSchema,
} from '../schemas.js';

describe('Input Length Validation', () => {
  describe('TicketSchema length limits', () => {
    it('accepts ticket id within 100 character limit', () => {
      const ticket = {
        id: 'a'.repeat(100),
        title: 'Valid title',
        description: 'Valid description',
      };
      expect(() => TicketSchema.parse(ticket)).not.toThrow();
    });

    it('rejects ticket id exceeding 100 characters', () => {
      const ticket = {
        id: 'a'.repeat(101),
        title: 'Valid title',
        description: 'Valid description',
      };
      expect(() => TicketSchema.parse(ticket)).toThrow();
    });

    it('accepts ticket title within 200 character limit', () => {
      const ticket = {
        id: 'ticket-1',
        title: 'a'.repeat(200),
        description: 'Valid description',
      };
      expect(() => TicketSchema.parse(ticket)).not.toThrow();
    });

    it('rejects ticket title exceeding 200 characters', () => {
      const ticket = {
        id: 'ticket-1',
        title: 'a'.repeat(201),
        description: 'Valid description',
      };
      expect(() => TicketSchema.parse(ticket)).toThrow();
    });

    it('accepts ticket description within 50000 character limit', () => {
      const ticket = {
        id: 'ticket-1',
        title: 'Valid title',
        description: 'a'.repeat(50000),
      };
      expect(() => TicketSchema.parse(ticket)).not.toThrow();
    });

    it('rejects ticket description exceeding 50000 characters', () => {
      const ticket = {
        id: 'ticket-1',
        title: 'Valid title',
        description: 'a'.repeat(50001),
      };
      expect(() => TicketSchema.parse(ticket)).toThrow();
    });
  });

  describe('ShellHookActionSchema length limits', () => {
    it('accepts command within 10000 character limit', () => {
      const action = {
        type: 'shell' as const,
        command: 'echo ' + 'a'.repeat(9995),
      };
      expect(() => ShellHookActionSchema.parse(action)).not.toThrow();
    });

    it('rejects command exceeding 10000 characters', () => {
      const action = {
        type: 'shell' as const,
        command: 'a'.repeat(10001),
      };
      expect(() => ShellHookActionSchema.parse(action)).toThrow();
    });
  });

  describe('PromptHookActionSchema length limits', () => {
    it('accepts command within 50000 character limit', () => {
      const action = {
        type: 'prompt' as const,
        command: 'a'.repeat(50000),
      };
      expect(() => PromptHookActionSchema.parse(action)).not.toThrow();
    });

    it('rejects command exceeding 50000 characters', () => {
      const action = {
        type: 'prompt' as const,
        command: 'a'.repeat(50001),
      };
      expect(() => PromptHookActionSchema.parse(action)).toThrow();
    });
  });
});
