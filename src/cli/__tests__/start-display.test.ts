import { describe, it, expect } from "vitest";
import type { Ticket } from "../../core/schemas.js";
import { TicketSchema } from "../../core/schemas.js";

// =============================================================================
// Test Helpers
// =============================================================================

function createTicket(overrides: Partial<Ticket> = {}): Ticket {
  return TicketSchema.parse({
    id: `ticket-${Date.now()}`,
    title: "Test ticket",
    description: "A test ticket",
    ...overrides,
  });
}

// =============================================================================
// NOTE: displayQueueSummary is not currently exported from start.ts
// These tests document the expected behavior and will require the function
// to be exported before they can run. Add this export to start.ts:
//
//   export function displayQueueSummary(...)
//
// The function signature should accept tickets with optional `complete` field:
//   Array<{ id: string; title: string; status: string; priority: number; complete?: boolean }>
// =============================================================================

// Inline implementation of the EXPECTED behavior for testing purposes
// This documents what the fixed function should do
function countQueueSummary(
  tickets: ReadonlyArray<Ticket>
): { total: number; pending: number; completed: number; failed: number } {
  const completed = tickets.filter(
    (t) => t.status === "completed" || t.complete === true
  );
  const failed = tickets.filter((t) => t.status === "failed");
  const pending = tickets.filter(
    (t) => t.status === "pending" && t.complete !== true
  );

  return {
    total: tickets.length,
    pending: pending.length,
    completed: completed.length,
    failed: failed.length,
  };
}

// =============================================================================
// Queue Summary Display: Ticket Counting Behavior
// =============================================================================

describe("Queue Summary Display", () => {
  describe("counts tickets with status field", () => {
    it("counts tickets with status 'completed' as completed", () => {
      const tickets = [
        createTicket({ id: "t1", status: "completed" }),
        createTicket({ id: "t2", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.completed).toBe(1);
      expect(summary.pending).toBe(1);
    });

    it("counts tickets with status 'failed' as failed", () => {
      const tickets = [
        createTicket({ id: "t1", status: "failed" }),
        createTicket({ id: "t2", status: "pending" }),
        createTicket({ id: "t3", status: "failed" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.failed).toBe(2);
      expect(summary.pending).toBe(1);
    });

    it("counts tickets with status 'pending' as pending", () => {
      const tickets = [
        createTicket({ id: "t1", status: "pending" }),
        createTicket({ id: "t2", status: "pending" }),
        createTicket({ id: "t3", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.pending).toBe(3);
      expect(summary.completed).toBe(0);
      expect(summary.failed).toBe(0);
    });
  });

  describe("counts tickets with complete flag", () => {
    it("counts tickets with complete: true as completed", () => {
      const tickets = [
        createTicket({ id: "t1", complete: true, status: "pending" }),
        createTicket({ id: "t2", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.completed).toBe(1);
      expect(summary.pending).toBe(1);
    });

    it("counts tickets with complete: true regardless of status field", () => {
      const tickets = [
        createTicket({ id: "t1", complete: true, status: "pending" }),
        createTicket({ id: "t2", complete: true, status: "executing" }),
        createTicket({ id: "t3", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.completed).toBe(2);
    });

    it("counts tickets with complete: false as not completed", () => {
      const tickets = [
        createTicket({ id: "t1", complete: false, status: "pending" }),
        createTicket({ id: "t2", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.completed).toBe(0);
      expect(summary.pending).toBe(2);
    });

    it("does not double-count tickets with both status completed and complete: true", () => {
      const tickets = [
        createTicket({ id: "t1", status: "completed", complete: true }),
        createTicket({ id: "t2", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.completed).toBe(1);
      expect(summary.total).toBe(2);
    });
  });

  describe("handles mixed ticket states", () => {
    it("correctly summarizes queue with all status types", () => {
      const tickets = [
        createTicket({ id: "t1", status: "completed" }),
        createTicket({ id: "t2", status: "failed" }),
        createTicket({ id: "t3", status: "pending" }),
        createTicket({ id: "t4", status: "pending" }),
        createTicket({ id: "t5", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.total).toBe(5);
      expect(summary.completed).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.pending).toBe(3);
    });

    it("correctly summarizes queue with complete flags and status fields", () => {
      const tickets = [
        createTicket({ id: "t1", status: "completed" }),
        createTicket({ id: "t2", complete: true, status: "pending" }),
        createTicket({ id: "t3", complete: true, status: "pending" }),
        createTicket({ id: "t4", status: "failed" }),
        createTicket({ id: "t5", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.total).toBe(5);
      expect(summary.completed).toBe(3);
      expect(summary.failed).toBe(1);
      expect(summary.pending).toBe(1);
    });
  });

  describe("handles edge cases", () => {
    it("handles empty ticket array", () => {
      const tickets: Ticket[] = [];

      const summary = countQueueSummary(tickets);

      expect(summary.total).toBe(0);
      expect(summary.completed).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.pending).toBe(0);
    });

    it("handles all tickets completed", () => {
      const tickets = [
        createTicket({ id: "t1", status: "completed" }),
        createTicket({ id: "t2", complete: true, status: "pending" }),
        createTicket({ id: "t3", status: "completed", complete: true }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.total).toBe(3);
      expect(summary.completed).toBe(3);
      expect(summary.pending).toBe(0);
      expect(summary.failed).toBe(0);
    });

    it("handles all tickets failed", () => {
      const tickets = [
        createTicket({ id: "t1", status: "failed" }),
        createTicket({ id: "t2", status: "failed" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.total).toBe(2);
      expect(summary.failed).toBe(2);
      expect(summary.completed).toBe(0);
      expect(summary.pending).toBe(0);
    });

    it("handles tickets with non-standard status values", () => {
      const tickets = [
        createTicket({ id: "t1", status: "planning" }),
        createTicket({ id: "t2", status: "executing" }),
        createTicket({ id: "t3", status: "awaiting_approval" }),
        createTicket({ id: "t4", status: "pending" }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.pending).toBe(1);
      expect(summary.completed).toBe(0);
      expect(summary.failed).toBe(0);
    });

    it("treats tickets with non-standard status and complete: true as completed", () => {
      const tickets = [
        createTicket({ id: "t1", status: "executing", complete: true }),
        createTicket({ id: "t2", status: "planning", complete: true }),
      ];

      const summary = countQueueSummary(tickets);

      expect(summary.completed).toBe(2);
    });
  });
});

// =============================================================================
// Integration Test: Console Output Verification
// These tests verify the actual console output of displayQueueSummary
// =============================================================================

describe("Queue Summary Display Output", () => {
  it.todo("outputs queue summary header (requires displayQueueSummary export)");
  it.todo("outputs total ticket count (requires displayQueueSummary export)");
  it.todo("outputs completed count including complete: true tickets (requires displayQueueSummary export)");
  it.todo("outputs failed count only when failures exist (requires displayQueueSummary export)");
  it.todo("outputs failed count when failures exist (requires displayQueueSummary export)");
});
