import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  RateLimitRetrySchema,
  ConfigSchema,
  TicketsFileSchema,
} from "../schemas.js";

// =============================================================================
// RateLimitRetrySchema — defaults
// =============================================================================

describe("RateLimitRetrySchema", () => {
  it("applies all defaults when parsing empty object", () => {
    const result = RateLimitRetrySchema.parse({});

    expect(result).toEqual({
      enabled: false,
      maxWaitTime: 21600000,
      retryBuffer: 30000,
      fallbackDelay: 300000,
      notifyOnWait: true,
    });
  });

  // ===========================================================================
  // String duration parsing
  // ===========================================================================

  it("parses maxWaitTime string duration to milliseconds", () => {
    const result = RateLimitRetrySchema.parse({ maxWaitTime: "2h" });

    expect(result.maxWaitTime).toBe(7200000);
  });

  it("parses retryBuffer string duration to milliseconds", () => {
    const result = RateLimitRetrySchema.parse({ retryBuffer: "1m" });

    expect(result.retryBuffer).toBe(60000);
  });

  it("parses fallbackDelay string duration to milliseconds", () => {
    const result = RateLimitRetrySchema.parse({ fallbackDelay: "10s" });

    expect(result.fallbackDelay).toBe(10000);
  });

  // ===========================================================================
  // Numeric duration passthrough
  // ===========================================================================

  it("passes through numeric maxWaitTime as raw milliseconds", () => {
    const result = RateLimitRetrySchema.parse({ maxWaitTime: 5000 });

    expect(result.maxWaitTime).toBe(5000);
  });

  // ===========================================================================
  // Boolean fields
  // ===========================================================================

  it("accepts enabled as true", () => {
    const result = RateLimitRetrySchema.parse({ enabled: true });

    expect(result.enabled).toBe(true);
  });

  it("accepts notifyOnWait as false", () => {
    const result = RateLimitRetrySchema.parse({ notifyOnWait: false });

    expect(result.notifyOnWait).toBe(false);
  });

  // ===========================================================================
  // Invalid values rejected
  // ===========================================================================

  it("rejects non-boolean enabled value", () => {
    const result = RateLimitRetrySchema.safeParse({ enabled: "yes" });

    expect(result.success).toBe(false);
  });

  it("rejects invalid duration string for maxWaitTime", () => {
    expect(() =>
      RateLimitRetrySchema.parse({ maxWaitTime: "invalid" })
    ).toThrow(ZodError);
  });

  it("rejects non-boolean notifyOnWait value", () => {
    const result = RateLimitRetrySchema.safeParse({ notifyOnWait: 1 });

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// ConfigSchema — rateLimitRetry integration
// =============================================================================

describe("ConfigSchema rateLimitRetry integration", () => {
  it("defaults rateLimitRetry with all default values when config is empty", () => {
    const result = ConfigSchema.parse({});

    expect(result.rateLimitRetry).toEqual({
      enabled: false,
      maxWaitTime: 21600000,
      retryBuffer: 30000,
      fallbackDelay: 300000,
      notifyOnWait: true,
    });
  });

  it("parses config with rateLimitRetry overrides", () => {
    const result = ConfigSchema.parse({
      rateLimitRetry: { enabled: true, maxWaitTime: "1h" },
    });

    expect(result.rateLimitRetry.enabled).toBe(true);
    expect(result.rateLimitRetry.maxWaitTime).toBe(3600000);
  });
});

// =============================================================================
// TicketsFileSchema — rateLimitRetry integration
// =============================================================================

describe("TicketsFileSchema rateLimitRetry integration", () => {
  it("parses tickets file with rateLimitRetry in config section", () => {
    const result = TicketsFileSchema.parse({
      config: {
        rateLimitRetry: { enabled: true, fallbackDelay: "2m" },
      },
      tickets: [{ id: "t1", title: "Test", description: "desc" }],
    });

    expect(result.config.rateLimitRetry.enabled).toBe(true);
    expect(result.config.rateLimitRetry.fallbackDelay).toBe(120000);
    expect(result.config.rateLimitRetry.retryBuffer).toBe(30000);
  });
});
