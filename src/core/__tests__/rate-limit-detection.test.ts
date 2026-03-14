import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateRateLimitWait,
  isRateLimitError,
  shouldFallback,
} from "../rate-limit-detection.js";

describe("isRateLimitError()", () => {
  describe("explicit detection - keyword matching", () => {
    it('detects "hit your limit" in error message (case insensitive)', () => {
      const result = isRateLimitError({
        success: false,
        error: "You have hit your limit for Claude API usage",
      });

      expect(result).toBe(true);
    });

    it('detects "hit your limit" with different casing', () => {
      const result = isRateLimitError({
        success: false,
        error: "ERROR: HIT YOUR LIMIT exceeded",
      });

      expect(result).toBe(true);
    });

    it('detects "usage limit" in error message', () => {
      const result = isRateLimitError({
        success: false,
        error: "Usage limit exceeded for this organization",
      });

      expect(result).toBe(true);
    });

    it('detects "usage limit" with different casing', () => {
      const result = isRateLimitError({
        success: false,
        error: "USAGE LIMIT has been reached",
      });

      expect(result).toBe(true);
    });

    it('detects "rate limit" in error message', () => {
      const result = isRateLimitError({
        success: false,
        error: "Rate limit exceeded. Please try again later.",
      });

      expect(result).toBe(true);
    });

    it('detects "rate limit" with different casing', () => {
      const result = isRateLimitError({
        success: false,
        error: "Error: RATE LIMIT exceeded",
      });

      expect(result).toBe(true);
    });
  });

  describe("heuristic detection - low cost + short output pattern", () => {
    it("detects rate limit with zero cost and short output", () => {
      const result = isRateLimitError({
        success: false,
        error: "Request failed",
        costUsd: 0,
        outputLength: 100,
      });

      expect(result).toBe(true);
    });

    it("detects rate limit with very low cost and minimal output", () => {
      const result = isRateLimitError({
        success: false,
        error: "Operation rejected",
        costUsd: 0.005,
        outputLength: 50,
      });

      expect(result).toBe(true);
    });

    it("detects rate limit with cost just under threshold", () => {
      const result = isRateLimitError({
        success: false,
        error: "Failed early",
        costUsd: 0.009,
        outputLength: 200,
      });

      expect(result).toBe(true);
    });

    it("detects rate limit with output just under threshold", () => {
      const result = isRateLimitError({
        success: false,
        error: "Request denied",
        costUsd: 0.001,
        outputLength: 499,
      });

      expect(result).toBe(true);
    });

    it("detects rate limit with undefined cost (treated as 0)", () => {
      const result = isRateLimitError({
        success: false,
        error: "No processing occurred",
        outputLength: 100,
      });

      expect(result).toBe(true);
    });

    it("detects rate limit with undefined outputLength (treated as 0)", () => {
      const result = isRateLimitError({
        success: false,
        error: "Rejected immediately",
        costUsd: 0.001,
      });

      expect(result).toBe(true);
    });
  });

  describe("false negatives - normal errors", () => {
    it("returns false for error with high cost", () => {
      const result = isRateLimitError({
        success: false,
        error: "Connection timeout",
        costUsd: 5.0,
        outputLength: 100,
      });

      expect(result).toBe(false);
    });

    it("returns false for error with cost at threshold", () => {
      const result = isRateLimitError({
        success: false,
        error: "Processing error",
        costUsd: 0.01,
        outputLength: 100,
      });

      expect(result).toBe(false);
    });

    it("returns false for error with long output", () => {
      const result = isRateLimitError({
        success: false,
        error: "Failed after processing",
        costUsd: 0.001,
        outputLength: 1000,
      });

      expect(result).toBe(false);
    });

    it("returns false for error with output at threshold", () => {
      const result = isRateLimitError({
        success: false,
        error: "Mid-processing failure",
        costUsd: 0.001,
        outputLength: 500,
      });

      expect(result).toBe(false);
    });

    it("returns false for error with high cost and long output", () => {
      const result = isRateLimitError({
        success: false,
        error: "Complex operation failed",
        costUsd: 0.5,
        outputLength: 5000,
      });

      expect(result).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for successful result", () => {
      const result = isRateLimitError({
        success: true,
        costUsd: 0.001,
        outputLength: 100,
      });

      expect(result).toBe(false);
    });

    it("returns true for successful result with rate limit keyword in error", () => {
      const result = isRateLimitError({
        success: true,
        error: "Warning: approaching rate limit",
        costUsd: 0.001,
        outputLength: 100,
      });

      expect(result).toBe(true);
    });

    it("returns false when error is undefined but cost and output are low", () => {
      const result = isRateLimitError({
        success: false,
        costUsd: 0.001,
        outputLength: 100,
      });

      expect(result).toBe(false);
    });

    it("returns true when error is empty string but heuristics match", () => {
      const result = isRateLimitError({
        success: false,
        error: "",
        costUsd: 0.001,
        outputLength: 100,
      });

      expect(result).toBe(true);
    });

    it("returns true when error contains rate limit keyword despite high cost", () => {
      const result = isRateLimitError({
        success: false,
        error: "Rate limit exceeded after partial processing",
        costUsd: 5.0,
        outputLength: 5000,
      });

      expect(result).toBe(true);
    });
  });
});

describe("shouldFallback()", () => {
  describe("should fallback scenarios", () => {
    it("returns true when currentModel differs from fallbackModel", () => {
      const result = shouldFallback("opus", "sonnet");

      expect(result).toBe(true);
    });

    it("returns true when currentModel is opus and fallbackModel is haiku", () => {
      const result = shouldFallback("opus", "haiku");

      expect(result).toBe(true);
    });

    it("returns true when currentModel is undefined and fallbackModel is sonnet", () => {
      const result = shouldFallback(undefined, "sonnet");

      expect(result).toBe(true);
    });

    it("returns true when currentModel is undefined and fallbackModel is opus", () => {
      const result = shouldFallback(undefined, "opus");

      expect(result).toBe(true);
    });

    it("returns true with full model identifiers", () => {
      const result = shouldFallback("claude-opus-4-6", "claude-sonnet-4-5");

      expect(result).toBe(true);
    });
  });

  describe("should not fallback scenarios", () => {
    it("returns false when currentModel matches fallbackModel", () => {
      const result = shouldFallback("sonnet", "sonnet");

      expect(result).toBe(false);
    });

    it("returns false when both models are opus", () => {
      const result = shouldFallback("opus", "opus");

      expect(result).toBe(false);
    });

    it("returns false when both models are haiku", () => {
      const result = shouldFallback("haiku", "haiku");

      expect(result).toBe(false);
    });

    it("returns false with identical full model identifiers", () => {
      const result = shouldFallback("claude-sonnet-4-5", "claude-sonnet-4-5");

      expect(result).toBe(false);
    });
  });

  describe("case sensitivity", () => {
    it("returns true for models differing only by case", () => {
      const result = shouldFallback("Sonnet", "sonnet");

      expect(result).toBe(true);
    });

    it("returns true for OPUS vs opus", () => {
      const result = shouldFallback("OPUS", "opus");

      expect(result).toBe(true);
    });
  });
});

describe("calculateRateLimitWait()", () => {
  const FIXED_NOW = 1700000000000;
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns wait with delta plus buffer when resetsAt is in future within maxWaitTime", () => {
    const resetsAtEpochSeconds = FIXED_NOW / 1000 + 300;

    const result = calculateRateLimitWait({
      resetsAt: resetsAtEpochSeconds,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    expect(result.shouldWait).toBe(true);
    expect(result.waitMs).toBe(330_000);
  });

  it("returns shouldWait false when resetsAt exceeds maxWaitTime", () => {
    const sevenHoursInSeconds = 7 * 60 * 60;
    const resetsAtEpochSeconds = FIXED_NOW / 1000 + sevenHoursInSeconds;

    const result = calculateRateLimitWait({
      resetsAt: resetsAtEpochSeconds,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    expect(result.shouldWait).toBe(false);
  });

  it("returns retryBuffer as waitMs when resetsAt is in the past", () => {
    const resetsAtEpochSeconds = FIXED_NOW / 1000 - 60;

    const result = calculateRateLimitWait({
      resetsAt: resetsAtEpochSeconds,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    expect(result.shouldWait).toBe(true);
    expect(result.waitMs).toBe(30_000);
  });

  it("returns fallbackDelay as waitMs when resetsAt is null", () => {
    const result = calculateRateLimitWait({
      resetsAt: null,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    expect(result.shouldWait).toBe(true);
    expect(result.waitMs).toBe(300_000);
  });

  it("returns shouldWait false when resetsAt is null and fallbackDelay exceeds maxWaitTime", () => {
    const sevenHoursMs = 7 * 60 * 60 * 1000;

    const result = calculateRateLimitWait({
      resetsAt: null,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: sevenHoursMs,
    });

    expect(result.shouldWait).toBe(false);
  });

  it("returns retryBuffer as waitMs when resetsAt is exactly now", () => {
    const resetsAtEpochSeconds = FIXED_NOW / 1000;

    const result = calculateRateLimitWait({
      resetsAt: resetsAtEpochSeconds,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    expect(result.shouldWait).toBe(true);
    expect(result.waitMs).toBe(30_000);
  });

  it("includes a descriptive reason string in every result", () => {
    const futureResult = calculateRateLimitWait({
      resetsAt: FIXED_NOW / 1000 + 300,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    const exceedsMaxResult = calculateRateLimitWait({
      resetsAt: FIXED_NOW / 1000 + 7 * 60 * 60,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    const nullResult = calculateRateLimitWait({
      resetsAt: null,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    const pastResult = calculateRateLimitWait({
      resetsAt: FIXED_NOW / 1000 - 60,
      maxWaitTimeMs: SIX_HOURS_MS,
      retryBufferMs: 30_000,
      fallbackDelayMs: 300_000,
    });

    expect(futureResult.reason).toEqual(expect.any(String));
    expect(futureResult.reason.length).toBeGreaterThan(0);

    expect(exceedsMaxResult.reason).toEqual(expect.any(String));
    expect(exceedsMaxResult.reason.length).toBeGreaterThan(0);

    expect(nullResult.reason).toEqual(expect.any(String));
    expect(nullResult.reason.length).toBeGreaterThan(0);

    expect(pastResult.reason).toEqual(expect.any(String));
    expect(pastResult.reason.length).toBeGreaterThan(0);
  });
});
