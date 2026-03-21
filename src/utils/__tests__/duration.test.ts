import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { parseDuration, formatDuration, DurationSchema } from "../duration.js";

// =============================================================================
// parseDuration Tests
// =============================================================================

describe("parseDuration", () => {
  it("parses minutes to milliseconds", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });

  it("parses hours and minutes combined", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
  });

  it("parses seconds to milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  it("parses hours to milliseconds", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  it("parses hours, minutes, and seconds combined", () => {
    expect(parseDuration("1h2m3s")).toBe(3_723_000);
  });

  it("passes through a raw number unchanged", () => {
    expect(parseDuration(5000)).toBe(5000);
  });

  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow();
  });

  it("throws on non-duration alphabetic string", () => {
    expect(() => parseDuration("abc")).toThrow();
  });

  it("throws on unknown unit suffix", () => {
    expect(() => parseDuration("5x")).toThrow();
  });

  it("throws on negative duration string", () => {
    expect(() => parseDuration("-5m")).toThrow();
  });

  it("throws on negative number", () => {
    expect(() => parseDuration(-5000)).toThrow();
  });
});

// =============================================================================
// formatDuration Tests
// =============================================================================

describe("formatDuration", () => {
  it("formats milliseconds as minutes", () => {
    expect(formatDuration(300_000)).toBe("5m");
  });

  it("formats milliseconds as hours and minutes", () => {
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });

  it("formats milliseconds as seconds", () => {
    expect(formatDuration(30_000)).toBe("30s");
  });

  it("formats milliseconds as hours only", () => {
    expect(formatDuration(7_200_000)).toBe("2h");
  });

  it("formats milliseconds as hours, minutes, and seconds", () => {
    expect(formatDuration(3_723_000)).toBe("1h 2m 3s");
  });

  it("formats zero milliseconds as zero seconds", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("rounds sub-second values down to zero seconds", () => {
    expect(formatDuration(500)).toBe("0s");
  });
});

// =============================================================================
// DurationSchema Tests
// =============================================================================

describe("DurationSchema", () => {
  it("transforms a valid duration string to milliseconds", () => {
    expect(DurationSchema.parse("5m")).toBe(300_000);
  });

  it("passes through a valid number as milliseconds", () => {
    expect(DurationSchema.parse(5000)).toBe(5000);
  });

  it("throws ZodError on invalid duration string", () => {
    expect(() => DurationSchema.parse("abc")).toThrow(ZodError);
  });

  it("throws ZodError on negative number", () => {
    expect(() => DurationSchema.parse(-1)).toThrow(ZodError);
  });
});
