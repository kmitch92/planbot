import { describe, it, expect } from "vitest";
import { parseTicketsFile, safeParseTicketsFile } from "../schemas.js";

// =============================================================================
// Test helpers — minimal valid building blocks
// =============================================================================

const validTicket = {
  id: "ticket-1",
  title: "Test ticket",
  description: "A ticket used for schema verification tests",
};

function fileWithConfig(config: Record<string, unknown>) {
  return {
    config,
    tickets: [validTicket],
  };
}

function fileWithTicket(ticketOverrides: Record<string, unknown>) {
  return {
    config: {},
    tickets: [{ ...validTicket, ...ticketOverrides }],
  };
}

// =============================================================================
// Defaults — both fields absent at every level
// =============================================================================

describe("TicketsFileSchema verifyRetries / handoverEnabled defaults", () => {
  it("defaults verifyRetries to 0 and handoverEnabled to false when omitted at root config", () => {
    const result = parseTicketsFile({
      config: {},
      tickets: [validTicket],
    });

    expect(result.config.verifyRetries).toBe(0);
    expect(result.config.handoverEnabled).toBe(false);
  });

  it("parses minimal tickets file with no verify/handover keys at any level", () => {
    const result = parseTicketsFile({
      tickets: [validTicket],
    });

    expect(result.config.verifyRetries).toBe(0);
    expect(result.config.handoverEnabled).toBe(false);
    expect(result.tickets[0]?.verifyRetries).toBeUndefined();
    expect(result.tickets[0]?.handoverEnabled).toBeUndefined();
  });
});

// =============================================================================
// Root config — verifyRetries
// =============================================================================

describe("ConfigSchema verifyRetries (root level)", () => {
  it("accepts verifyRetries of 0", () => {
    const result = parseTicketsFile(fileWithConfig({ verifyRetries: 0 }));

    expect(result.config.verifyRetries).toBe(0);
  });

  it("accepts verifyRetries of 1", () => {
    const result = parseTicketsFile(fileWithConfig({ verifyRetries: 1 }));

    expect(result.config.verifyRetries).toBe(1);
  });

  it("accepts verifyRetries of 3", () => {
    const result = parseTicketsFile(fileWithConfig({ verifyRetries: 3 }));

    expect(result.config.verifyRetries).toBe(3);
  });

  it("accepts verifyRetries of 10", () => {
    const result = parseTicketsFile(fileWithConfig({ verifyRetries: 10 }));

    expect(result.config.verifyRetries).toBe(10);
  });

  it("rejects negative verifyRetries (-1)", () => {
    const result = safeParseTicketsFile(fileWithConfig({ verifyRetries: -1 }));

    expect(result.success).toBe(false);
  });

  it("rejects non-integer verifyRetries (1.5)", () => {
    const result = safeParseTicketsFile(fileWithConfig({ verifyRetries: 1.5 }));

    expect(result.success).toBe(false);
  });

  it("rejects string verifyRetries (\"3\")", () => {
    const result = safeParseTicketsFile(fileWithConfig({ verifyRetries: "3" }));

    expect(result.success).toBe(false);
  });

  it("rejects boolean verifyRetries (true)", () => {
    const result = safeParseTicketsFile(fileWithConfig({ verifyRetries: true }));

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Root config — handoverEnabled
// =============================================================================

describe("ConfigSchema handoverEnabled (root level)", () => {
  it("accepts handoverEnabled true", () => {
    const result = parseTicketsFile(fileWithConfig({ handoverEnabled: true }));

    expect(result.config.handoverEnabled).toBe(true);
  });

  it("accepts handoverEnabled false", () => {
    const result = parseTicketsFile(fileWithConfig({ handoverEnabled: false }));

    expect(result.config.handoverEnabled).toBe(false);
  });

  it("rejects string handoverEnabled (\"yes\")", () => {
    const result = safeParseTicketsFile(
      fileWithConfig({ handoverEnabled: "yes" }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects numeric handoverEnabled (1)", () => {
    const result = safeParseTicketsFile(
      fileWithConfig({ handoverEnabled: 1 }),
    );

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Per-ticket — verifyRetries (optional override)
// =============================================================================

describe("TicketSchema verifyRetries (per-ticket override)", () => {
  it("parses a ticket without verifyRetries (field is optional)", () => {
    const result = parseTicketsFile(fileWithTicket({}));

    expect(result.tickets[0]?.verifyRetries).toBeUndefined();
  });

  it("preserves a per-ticket verifyRetries value", () => {
    const result = parseTicketsFile(fileWithTicket({ verifyRetries: 5 }));

    expect(result.tickets[0]?.verifyRetries).toBe(5);
  });

  it("accepts per-ticket verifyRetries of 0", () => {
    const result = parseTicketsFile(fileWithTicket({ verifyRetries: 0 }));

    expect(result.tickets[0]?.verifyRetries).toBe(0);
  });

  it("rejects negative per-ticket verifyRetries", () => {
    const result = safeParseTicketsFile(fileWithTicket({ verifyRetries: -2 }));

    expect(result.success).toBe(false);
  });

  it("rejects non-integer per-ticket verifyRetries", () => {
    const result = safeParseTicketsFile(
      fileWithTicket({ verifyRetries: 2.5 }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects string per-ticket verifyRetries", () => {
    const result = safeParseTicketsFile(
      fileWithTicket({ verifyRetries: "2" }),
    );

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Per-ticket — handoverEnabled (optional override)
// =============================================================================

describe("TicketSchema handoverEnabled (per-ticket override)", () => {
  it("parses a ticket without handoverEnabled (field is optional)", () => {
    const result = parseTicketsFile(fileWithTicket({}));

    expect(result.tickets[0]?.handoverEnabled).toBeUndefined();
  });

  it("preserves a per-ticket handoverEnabled value of true", () => {
    const result = parseTicketsFile(fileWithTicket({ handoverEnabled: true }));

    expect(result.tickets[0]?.handoverEnabled).toBe(true);
  });

  it("preserves a per-ticket handoverEnabled value of false", () => {
    const result = parseTicketsFile(
      fileWithTicket({ handoverEnabled: false }),
    );

    expect(result.tickets[0]?.handoverEnabled).toBe(false);
  });

  it("rejects string per-ticket handoverEnabled", () => {
    const result = safeParseTicketsFile(
      fileWithTicket({ handoverEnabled: "no" }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects numeric per-ticket handoverEnabled", () => {
    const result = safeParseTicketsFile(
      fileWithTicket({ handoverEnabled: 0 }),
    );

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Combined — root + per-ticket together
// =============================================================================

describe("TicketsFileSchema verifyRetries + handoverEnabled combined", () => {
  it("parses a mixed example with root-level and per-ticket overrides", () => {
    const result = parseTicketsFile({
      config: {
        verifyRetries: 2,
        handoverEnabled: true,
      },
      tickets: [
        {
          ...validTicket,
          id: "ticket-a",
          verifyRetries: 5,
          handoverEnabled: false,
        },
        {
          ...validTicket,
          id: "ticket-b",
        },
      ],
    });

    expect(result.config.verifyRetries).toBe(2);
    expect(result.config.handoverEnabled).toBe(true);

    expect(result.tickets[0]?.id).toBe("ticket-a");
    expect(result.tickets[0]?.verifyRetries).toBe(5);
    expect(result.tickets[0]?.handoverEnabled).toBe(false);

    expect(result.tickets[1]?.id).toBe("ticket-b");
    expect(result.tickets[1]?.verifyRetries).toBeUndefined();
    expect(result.tickets[1]?.handoverEnabled).toBeUndefined();
  });
});
