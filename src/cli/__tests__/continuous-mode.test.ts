import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Ticket } from "../../core/schemas.js";
import {
  isExitCommand,
  generateContinuousTicketId,
  parseUserInputToTicket,
} from "../commands/start.js";

// =============================================================================
// isExitCommand Tests
// =============================================================================

describe("isExitCommand", () => {
  describe("recognizes exit commands", () => {
    it("returns true for 'exit'", () => {
      expect(isExitCommand("exit")).toBe(true);
    });

    it("returns true for 'quit'", () => {
      expect(isExitCommand("quit")).toBe(true);
    });

    it("returns true for 'q'", () => {
      expect(isExitCommand("q")).toBe(true);
    });

    it("returns true for 'done'", () => {
      expect(isExitCommand("done")).toBe(true);
    });

    it("returns true for 'stop'", () => {
      expect(isExitCommand("stop")).toBe(true);
    });
  });

  describe("handles case insensitivity", () => {
    it("returns true for 'EXIT' (uppercase)", () => {
      expect(isExitCommand("EXIT")).toBe(true);
    });

    it("returns true for 'Quit' (mixed case)", () => {
      expect(isExitCommand("Quit")).toBe(true);
    });

    it("returns true for 'DONE' (uppercase)", () => {
      expect(isExitCommand("DONE")).toBe(true);
    });

    it("returns true for 'sToP' (mixed case)", () => {
      expect(isExitCommand("sToP")).toBe(true);
    });
  });

  describe("handles whitespace", () => {
    it("returns true for '  exit  ' (leading and trailing whitespace)", () => {
      expect(isExitCommand("  exit  ")).toBe(true);
    });

    it("returns true for 'quit\\n' (trailing newline)", () => {
      expect(isExitCommand("quit\n")).toBe(true);
    });

    it("returns true for '\\t q \\t' (tabs and spaces)", () => {
      expect(isExitCommand("\t q \t")).toBe(true);
    });
  });

  describe("rejects non-exit input", () => {
    it("returns false for empty string", () => {
      expect(isExitCommand("")).toBe(false);
    });

    it("returns false for whitespace-only string", () => {
      expect(isExitCommand("   ")).toBe(false);
    });

    it("returns false for normal plan text", () => {
      expect(isExitCommand("Add user authentication")).toBe(false);
    });

    it("returns false for text containing exit keyword", () => {
      expect(isExitCommand("exit the building")).toBe(false);
    });

    it("returns false for exit-like words", () => {
      expect(isExitCommand("quitting")).toBe(false);
      expect(isExitCommand("exiting")).toBe(false);
      expect(isExitCommand("stopped")).toBe(false);
    });

    it("returns false for commands with extra content", () => {
      expect(isExitCommand("exit now")).toBe(false);
      expect(isExitCommand("quit please")).toBe(false);
    });
  });
});

// =============================================================================
// generateContinuousTicketId Tests
// =============================================================================

describe("generateContinuousTicketId", () => {
  describe("format requirements", () => {
    it("returns a string starting with 'cont-'", () => {
      const id = generateContinuousTicketId();

      expect(id.startsWith("cont-")).toBe(true);
    });

    it("includes timestamp in the ID", () => {
      const beforeTimestamp = Date.now();
      const id = generateContinuousTicketId();
      const afterTimestamp = Date.now();

      const parts = id.split("-");
      const timestampPart = parseInt(parts[1] ?? "0", 10);

      expect(timestampPart).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(timestampPart).toBeLessThanOrEqual(afterTimestamp);
    });

    it("includes random hex suffix", () => {
      const id = generateContinuousTicketId();
      const parts = id.split("-");

      expect(parts.length).toBeGreaterThanOrEqual(3);

      const hexPart = parts[parts.length - 1];
      expect(hexPart).toBeDefined();
      expect(hexPart).toMatch(/^[0-9a-f]+$/i);
    });

    it("returns a valid string format matching expected pattern", () => {
      const id = generateContinuousTicketId();

      expect(id).toMatch(/^cont-\d+-[0-9a-f]+$/i);
    });
  });

  describe("uniqueness", () => {
    it("generates unique IDs on consecutive calls", () => {
      const id1 = generateContinuousTicketId();
      const id2 = generateContinuousTicketId();
      const id3 = generateContinuousTicketId();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it("generates unique IDs in rapid succession (100 calls)", () => {
      const ids = new Set<string>();

      for (let i = 0; i < 100; i++) {
        ids.add(generateContinuousTicketId());
      }

      expect(ids.size).toBe(100);
    });

    it("differs in random suffix even when timestamp matches", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T10:30:00.000Z"));

      const id1 = generateContinuousTicketId();
      const id2 = generateContinuousTicketId();

      expect(id1).not.toBe(id2);

      vi.useRealTimers();
    });
  });

  describe("ID length constraints", () => {
    it("generates an ID within reasonable length bounds", () => {
      const id = generateContinuousTicketId();

      expect(id.length).toBeGreaterThan(10);
      expect(id.length).toBeLessThanOrEqual(100);
    });
  });
});

// =============================================================================
// parseUserInputToTicket Tests
// =============================================================================

describe("parseUserInputToTicket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:30:00.000Z"));
  });

  describe("returns null for invalid input", () => {
    it("returns null for empty input", () => {
      const result = parseUserInputToTicket("");

      expect(result).toBeNull();
    });

    it("returns null for whitespace-only input", () => {
      expect(parseUserInputToTicket("   ")).toBeNull();
      expect(parseUserInputToTicket("\t")).toBeNull();
      expect(parseUserInputToTicket("\n")).toBeNull();
      expect(parseUserInputToTicket("  \n  \t  ")).toBeNull();
    });
  });

  describe("single-line input handling", () => {
    it("uses entire line as title", () => {
      const input = "Add user authentication";
      const result = parseUserInputToTicket(input);

      expect(result).not.toBeNull();
      expect(result?.title).toBe("Add user authentication");
    });

    it("uses entire line as description", () => {
      const input = "Add user authentication";
      const result = parseUserInputToTicket(input);

      expect(result?.description).toBe("Add user authentication");
    });

    it("trims whitespace from title", () => {
      const input = "  Add feature  ";
      const result = parseUserInputToTicket(input);

      expect(result?.title).toBe("Add feature");
    });

    it("truncates title to 200 characters maximum", () => {
      const longText = "A".repeat(250);
      const result = parseUserInputToTicket(longText);

      expect(result?.title.length).toBe(200);
      expect(result?.title).toBe("A".repeat(200));
    });
  });

  describe("multi-line input handling", () => {
    it("uses first line as title", () => {
      const input = "Implement login\nAdd username and password fields\nValidate credentials";
      const result = parseUserInputToTicket(input);

      expect(result?.title).toBe("Implement login");
    });

    it("uses remaining lines as description", () => {
      const input = "Implement login\nAdd username and password fields\nValidate credentials";
      const result = parseUserInputToTicket(input);

      expect(result?.description).toBe(
        "Add username and password fields\nValidate credentials"
      );
    });

    it("trims whitespace from first line for title", () => {
      const input = "  Feature title  \nDescription here";
      const result = parseUserInputToTicket(input);

      expect(result?.title).toBe("Feature title");
    });

    it("preserves whitespace in description body", () => {
      const input = "Title\n  Indented line\n    More indent";
      const result = parseUserInputToTicket(input);

      expect(result?.description).toBe("  Indented line\n    More indent");
    });

    it("truncates first line title to 200 characters", () => {
      const longTitle = "T".repeat(250);
      const input = `${longTitle}\nDescription text`;
      const result = parseUserInputToTicket(input);

      expect(result?.title.length).toBe(200);
      expect(result?.title).toBe("T".repeat(200));
    });

    it("handles CRLF line endings", () => {
      const input = "Title\r\nDescription line 1\r\nDescription line 2";
      const result = parseUserInputToTicket(input);

      expect(result?.title).toBe("Title");
      expect(result?.description).toContain("Description line 1");
      expect(result?.description).toContain("Description line 2");
    });
  });

  describe("ticket object structure", () => {
    it("returns a valid Ticket object", () => {
      const input = "Test ticket";
      const result = parseUserInputToTicket(input);

      expect(result).not.toBeNull();
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("priority");
      expect(result).toHaveProperty("status");
    });

    it("generates a valid ticket ID starting with 'cont-'", () => {
      const result = parseUserInputToTicket("Test");

      expect(result?.id).toMatch(/^cont-/);
    });

    it("sets priority to 0", () => {
      const result = parseUserInputToTicket("Test");

      expect(result?.priority).toBe(0);
    });

    it("sets status to 'pending'", () => {
      const result = parseUserInputToTicket("Test");

      expect(result?.status).toBe("pending");
    });

    it("generates unique IDs for different inputs", () => {
      const result1 = parseUserInputToTicket("First ticket");
      const result2 = parseUserInputToTicket("Second ticket");

      expect(result1?.id).not.toBe(result2?.id);
    });
  });

  describe("type compliance", () => {
    it("returns object conforming to Ticket interface", () => {
      const input = "Add feature\nWith detailed description";
      const result = parseUserInputToTicket(input);

      if (result === null) {
        throw new Error("Expected result to not be null");
      }

      const ticket: Ticket = result;

      expect(ticket.id).toBeDefined();
      expect(ticket.title).toBeDefined();
      expect(ticket.description).toBeDefined();
      expect(ticket.priority).toBeDefined();
      expect(ticket.status).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("handles input with only newlines", () => {
      const result = parseUserInputToTicket("\n\n\n");

      expect(result).toBeNull();
    });

    it("handles input with empty first line", () => {
      const input = "\nActual content here";
      const result = parseUserInputToTicket(input);

      expect(result?.title).toBe("Actual content here");
    });

    it("handles unicode characters in input", () => {
      const input = "Add emoji support: heart, star, check";
      const result = parseUserInputToTicket(input);

      expect(result?.title).toContain("emoji");
    });

    it("handles very long description gracefully", () => {
      const longDescription = "D".repeat(10000);
      const input = `Short title\n${longDescription}`;
      const result = parseUserInputToTicket(input);

      expect(result).not.toBeNull();
      expect(result?.title).toBe("Short title");
      expect(result?.description.length).toBe(10000);
    });
  });
});
