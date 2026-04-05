import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  generateMarkdownSummary,
  resolveFormat,
  type CriterionResult,
  type TicketVerification,
} from "../commands/verify.js";

function makeCriterion(
  overrides: Partial<CriterionResult> & { index: number },
): CriterionResult {
  return {
    text: `Criterion ${overrides.index}`,
    status: "PASS",
    reason: "Verified",
    ...overrides,
  };
}

function makeTicketVerification(
  overrides: Partial<TicketVerification> & { ticketId: string },
): TicketVerification {
  return {
    ticketTitle: overrides.ticketId,
    criteria: [],
    result: "PASS",
    ...overrides,
  };
}

describe("generateMarkdownSummary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces a report header with zero counts for empty results", () => {
    const output = generateMarkdownSummary([]);

    expect(output).toContain("# Verification Report");
    expect(output).toContain("**Date**: 2026-04-05T12:00:00.000Z");
    expect(output).toContain("**Tickets**: 0");
    expect(output).toContain("**Passed**: 0");
    expect(output).toContain("**Failed**: 0");
    expect(output).not.toContain("## Details");
  });

  it("renders a single passing ticket with summary table and detail section", () => {
    const results: TicketVerification[] = [
      makeTicketVerification({
        ticketId: "PROJ-1",
        ticketTitle: "Add login page",
        result: "PASS",
        criteria: [
          makeCriterion({ index: 0, text: "Login form renders", status: "PASS", reason: "Form component found" }),
          makeCriterion({ index: 1, text: "Validation works", status: "PASS", reason: "Errors shown" }),
          makeCriterion({ index: 2, text: "Submit calls API", status: "PASS", reason: "POST request sent" }),
        ],
      }),
    ];

    const output = generateMarkdownSummary(results);

    expect(output).toContain("**Tickets**: 1");
    expect(output).toContain("**Passed**: 1");
    expect(output).toContain("**Failed**: 0");

    expect(output).toContain("| PROJ-1 | Add login page | PASS | 3/3 |");

    expect(output).toContain("### PROJ-1: Add login page");
    expect(output).toContain("**Result**: PASS (3/3 criteria passed)");
    expect(output).toContain("| 0 | Login form renders | PASS | Form component found |");
    expect(output).toContain("| 1 | Validation works | PASS | Errors shown |");
    expect(output).toContain("| 2 | Submit calls API | PASS | POST request sent |");
  });

  it("renders mixed FAIL and SKIP criteria with correct status values", () => {
    const results: TicketVerification[] = [
      makeTicketVerification({
        ticketId: "PROJ-2",
        ticketTitle: "Fix nav bug",
        result: "FAIL",
        criteria: [
          makeCriterion({ index: 0, text: "Nav renders", status: "PASS", reason: "Works" }),
          makeCriterion({ index: 1, text: "Mobile menu", status: "FAIL", reason: "Not found" }),
          makeCriterion({ index: 2, text: "Animations", status: "SKIP", reason: "Cannot test" }),
        ],
      }),
    ];

    const output = generateMarkdownSummary(results);

    expect(output).toContain("**Failed**: 1");
    expect(output).toContain("| PROJ-2 | Fix nav bug | FAIL | 1/3 |");
    expect(output).toContain("**Result**: FAIL (1/3 criteria passed)");
    expect(output).toContain("| 1 | Mobile menu | FAIL | Not found |");
    expect(output).toContain("| 2 | Animations | SKIP | Cannot test |");
  });

  it("renders multiple tickets with correct row counts and ordered detail sections", () => {
    const results: TicketVerification[] = [
      makeTicketVerification({
        ticketId: "T-1",
        ticketTitle: "First ticket",
        result: "PASS",
        criteria: [
          makeCriterion({ index: 0, text: "Check A", status: "PASS", reason: "OK" }),
        ],
      }),
      makeTicketVerification({
        ticketId: "T-2",
        ticketTitle: "Second ticket",
        result: "FAIL",
        criteria: [
          makeCriterion({ index: 0, text: "Check B", status: "FAIL", reason: "Missing" }),
        ],
      }),
      makeTicketVerification({
        ticketId: "T-3",
        ticketTitle: "Third ticket",
        result: "PARTIAL",
        criteria: [
          makeCriterion({ index: 0, text: "Check C", status: "PASS", reason: "Found" }),
          makeCriterion({ index: 1, text: "Check D", status: "FAIL", reason: "Absent" }),
        ],
      }),
    ];

    const output = generateMarkdownSummary(results);

    expect(output).toContain("**Tickets**: 3");
    expect(output).toContain("**Passed**: 1");
    expect(output).toContain("**Failed**: 2");

    expect(output).toContain("| T-1 | First ticket | PASS | 1/1 |");
    expect(output).toContain("| T-2 | Second ticket | FAIL | 0/1 |");
    expect(output).toContain("| T-3 | Third ticket | PARTIAL | 1/2 |");

    const t1Pos = output.indexOf("### T-1:");
    const t2Pos = output.indexOf("### T-2:");
    const t3Pos = output.indexOf("### T-3:");
    expect(t1Pos).toBeLessThan(t2Pos);
    expect(t2Pos).toBeLessThan(t3Pos);
  });

  it("escapes pipe characters in criterion text and reason to preserve table formatting", () => {
    const results: TicketVerification[] = [
      makeTicketVerification({
        ticketId: "ESC-1",
        ticketTitle: "Escape test",
        result: "PASS",
        criteria: [
          makeCriterion({
            index: 0,
            text: "Input | Output validation",
            status: "PASS",
            reason: "Checked A | B",
          }),
        ],
      }),
    ];

    const output = generateMarkdownSummary(results);

    expect(output).toContain("Input \\| Output validation");
    expect(output).toContain("Checked A \\| B");
    const detailLines = output.split("\n").filter((l) => l.includes("Input"));
    for (const line of detailLines) {
      const unescapedPipes = line.replace(/\\\|/g, "").split("|").length - 1;
      expect(unescapedPipes).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("resolveFormat", () => {
  it("returns json when explicit format is json regardless of file extension", () => {
    expect(resolveFormat("json", "report.md")).toBe("json");
  });

  it("returns markdown when explicit format is markdown regardless of file extension", () => {
    expect(resolveFormat("markdown", "report.json")).toBe("markdown");
  });

  it("infers markdown from .md file extension", () => {
    expect(resolveFormat(undefined, "report.md")).toBe("markdown");
  });

  it("infers markdown from .markdown file extension", () => {
    expect(resolveFormat(undefined, "output.markdown")).toBe("markdown");
  });

  it("infers json from .json file extension", () => {
    expect(resolveFormat(undefined, "results.json")).toBe("json");
  });

  it("defaults to json for unrecognized extensions", () => {
    expect(resolveFormat(undefined, "report.txt")).toBe("json");
    expect(resolveFormat(undefined, "output.csv")).toBe("json");
    expect(resolveFormat(undefined, "data")).toBe("json");
  });
});
