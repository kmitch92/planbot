import { describe, it, expect } from "vitest";
import {
  ShellHookActionSchema,
  PromptHookActionSchema,
  HooksSchema,
} from "../schemas.js";

// =============================================================================
// ShellHookActionSchema — every field
// =============================================================================

describe("ShellHookActionSchema every field", () => {
  it("accepts every with a positive integer", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      every: 5,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.every).toBe(5);
    }
  });

  it("treats every as undefined when omitted", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.every).toBeUndefined();
    }
  });

  it("rejects every of zero", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      every: 0,
    });

    expect(result.success).toBe(false);
  });

  it("rejects negative every value", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      every: -1,
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-integer every value", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      every: 1.5,
    });

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// PromptHookActionSchema — every field
// =============================================================================

describe("PromptHookActionSchema every field", () => {
  it("accepts every with a positive integer", () => {
    const result = PromptHookActionSchema.safeParse({
      type: "prompt",
      command: "Check coverage",
      every: 10,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.every).toBe(10);
    }
  });

  it("treats every as undefined when omitted", () => {
    const result = PromptHookActionSchema.safeParse({
      type: "prompt",
      command: "Check coverage",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.every).toBeUndefined();
    }
  });

  it("rejects every of zero", () => {
    const result = PromptHookActionSchema.safeParse({
      type: "prompt",
      command: "Check coverage",
      every: 0,
    });

    expect(result.success).toBe(false);
  });

  it("rejects negative every value", () => {
    const result = PromptHookActionSchema.safeParse({
      type: "prompt",
      command: "Check coverage",
      every: -1,
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-integer every value", () => {
    const result = PromptHookActionSchema.safeParse({
      type: "prompt",
      command: "Check coverage",
      every: 1.5,
    });

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// HooksSchema — every field integration (round-trip)
// =============================================================================

describe("HooksSchema with every on onIterationComplete actions", () => {
  it("parses hooks object with every on shell action in onIterationComplete", () => {
    const input = {
      onIterationComplete: [
        { type: "shell" as const, command: "npm test", every: 10 },
      ],
    };

    const result = HooksSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const action = result.data.onIterationComplete?.[0];
      expect(action).toMatchObject({
        type: "shell",
        command: "npm test",
        every: 10,
      });
    }
  });

  it("parses hooks object with every on prompt action in onIterationComplete", () => {
    const input = {
      onIterationComplete: [
        { type: "prompt" as const, command: "Verify progress", every: 3 },
      ],
    };

    const result = HooksSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      const action = result.data.onIterationComplete?.[0];
      expect(action).toMatchObject({
        type: "prompt",
        command: "Verify progress",
        every: 3,
      });
    }
  });
});
