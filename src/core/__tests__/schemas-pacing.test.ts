import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { PacingSchema, ConfigSchema, TicketSchema } from "../schemas.js";

// =============================================================================
// PacingSchema
// =============================================================================

describe("PacingSchema", () => {
  it("parses empty object successfully", () => {
    const result = PacingSchema.parse({});

    expect(result).toEqual({});
  });

  it("parses string durations and transforms to milliseconds", () => {
    const result = PacingSchema.parse({ delayBetweenTickets: "5m" });

    expect(result.delayBetweenTickets).toBe(300000);
  });

  it("parses number durations as raw milliseconds", () => {
    const result = PacingSchema.parse({ delayBetweenTickets: 5000 });

    expect(result.delayBetweenTickets).toBe(5000);
  });

  it("parses all fields together", () => {
    const result = PacingSchema.parse({
      delayBetweenTickets: "5m",
      delayBetweenIterations: "2m",
      delayBetweenRetries: "30s",
      startAfter: "2026-03-14T22:00:00Z",
    });

    expect(result.delayBetweenTickets).toBe(300000);
    expect(result.delayBetweenIterations).toBe(120000);
    expect(result.delayBetweenRetries).toBe(30000);
    expect(result.startAfter).toBe("2026-03-14T22:00:00Z");
  });

  it("rejects invalid duration string", () => {
    expect(() => PacingSchema.parse({ delayBetweenTickets: "abc" })).toThrow(
      ZodError
    );
  });

  it("rejects invalid startAfter value", () => {
    expect(() => PacingSchema.parse({ startAfter: "not-a-date" })).toThrow(
      ZodError
    );
  });

  it("rejects negative number duration", () => {
    expect(() => PacingSchema.parse({ delayBetweenTickets: -1 })).toThrow(
      ZodError
    );
  });
});

// =============================================================================
// ConfigSchema — pacing integration
// =============================================================================

describe("ConfigSchema pacing integration", () => {
  it("defaults pacing to empty object", () => {
    const result = ConfigSchema.parse({});

    expect(result.pacing).toEqual({});
  });

  it("parses config with pacing durations", () => {
    const result = ConfigSchema.parse({
      pacing: { delayBetweenTickets: "5m" },
    });

    expect(result.pacing.delayBetweenTickets).toBe(300000);
  });
});

// =============================================================================
// TicketSchema — pacing integration
// =============================================================================

describe("TicketSchema pacing integration", () => {
  const validTicketBase = {
    id: "t1",
    title: "Test",
    description: "desc",
  };

  it("accepts a ticket without pacing (optional)", () => {
    const result = TicketSchema.parse(validTicketBase);

    expect(result.pacing).toBeUndefined();
  });

  it("parses ticket with pacing durations", () => {
    const result = TicketSchema.parse({
      ...validTicketBase,
      pacing: { delayBetweenIterations: "10m" },
    });

    expect(result.pacing?.delayBetweenIterations).toBe(600000);
  });
});
