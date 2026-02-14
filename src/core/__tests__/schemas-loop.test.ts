import { describe, it, expect } from "vitest";
import {
  ShellConditionSchema,
  PromptConditionSchema,
  LoopConditionSchema,
  LoopConfigSchema,
  TicketSchema,
  StateSchema,
  createDefaultState,
} from "../schemas.js";

// =============================================================================
// LoopConditionSchema
// =============================================================================

describe("LoopConditionSchema", () => {
  it("parses a valid shell condition", () => {
    const result = LoopConditionSchema.safeParse({
      type: "shell",
      command: "test -f foo",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("shell");
      expect(result.data.command).toBe("test -f foo");
    }
  });

  it("parses a valid prompt condition", () => {
    const result = LoopConditionSchema.safeParse({
      type: "prompt",
      command: "Is coverage above 80%?",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("prompt");
      expect(result.data.command).toBe("Is coverage above 80%?");
    }
  });

  it("rejects missing type discriminator", () => {
    const result = LoopConditionSchema.safeParse({
      command: "test -f foo",
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid type value", () => {
    const result = LoopConditionSchema.safeParse({
      type: "invalid",
      command: "test -f foo",
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty command string", () => {
    const shellResult = ShellConditionSchema.safeParse({
      type: "shell",
      command: "",
    });
    const promptResult = PromptConditionSchema.safeParse({
      type: "prompt",
      command: "",
    });

    expect(shellResult.success).toBe(false);
    expect(promptResult.success).toBe(false);
  });
});

// =============================================================================
// LoopConfigSchema
// =============================================================================

describe("LoopConfigSchema", () => {
  const validCondition = { type: "shell" as const, command: "test -f done.txt" };

  it("parses a valid config with all fields", () => {
    const result = LoopConfigSchema.safeParse({
      goal: "Achieve 100% test coverage",
      condition: validCondition,
      maxIterations: 5,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.goal).toBe("Achieve 100% test coverage");
      expect(result.data.condition).toEqual(validCondition);
      expect(result.data.maxIterations).toBe(5);
    }
  });

  it("defaults maxIterations to 10 when omitted", () => {
    const result = LoopConfigSchema.safeParse({
      goal: "Run until stable",
      condition: validCondition,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxIterations).toBe(10);
    }
  });

  it("rejects maxIterations of 0", () => {
    const result = LoopConfigSchema.safeParse({
      goal: "Run until stable",
      condition: validCondition,
      maxIterations: 0,
    });

    expect(result.success).toBe(false);
  });

  it("rejects maxIterations of 101", () => {
    const result = LoopConfigSchema.safeParse({
      goal: "Run until stable",
      condition: validCondition,
      maxIterations: 101,
    });

    expect(result.success).toBe(false);
  });

  it("accepts maxIterations boundary value 1", () => {
    const result = LoopConfigSchema.safeParse({
      goal: "Single iteration",
      condition: validCondition,
      maxIterations: 1,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxIterations).toBe(1);
    }
  });

  it("accepts maxIterations boundary value 100", () => {
    const result = LoopConfigSchema.safeParse({
      goal: "Maximum iterations",
      condition: validCondition,
      maxIterations: 100,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxIterations).toBe(100);
    }
  });

  it("rejects missing goal", () => {
    const result = LoopConfigSchema.safeParse({
      condition: validCondition,
      maxIterations: 5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects missing condition", () => {
    const result = LoopConfigSchema.safeParse({
      goal: "Run until stable",
      maxIterations: 5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty goal string", () => {
    const result = LoopConfigSchema.safeParse({
      goal: "",
      condition: validCondition,
      maxIterations: 5,
    });

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// TicketSchema — loop field
// =============================================================================

describe("TicketSchema loop field", () => {
  const validTicketBase = {
    id: "ticket-1",
    title: "Implement feature",
    description: "Build the loop feature end to end",
  };

  it("accepts a ticket without loop field (backward compatibility)", () => {
    const result = TicketSchema.safeParse(validTicketBase);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loop).toBeUndefined();
    }
  });

  it("parses a ticket with a valid loop field", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      loop: {
        goal: "All tests pass",
        condition: { type: "shell", command: "npm test" },
        maxIterations: 3,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loop).toBeDefined();
      expect(result.data.loop?.goal).toBe("All tests pass");
      expect(result.data.loop?.maxIterations).toBe(3);
    }
  });

  it("rejects a ticket with an invalid loop field", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      loop: {
        goal: "Missing condition field",
      },
    });

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// StateSchema — loopState field
// =============================================================================

describe("StateSchema loopState field", () => {
  const now = new Date().toISOString();
  const validStateBase = {
    version: "1.0.0",
    currentTicketId: null,
    currentPhase: "idle" as const,
    sessionId: null,
    pauseRequested: false,
    startedAt: now,
    lastUpdatedAt: now,
    pendingQuestions: [],
  };

  it("parses state with loopState set to null", () => {
    const result = StateSchema.safeParse({
      ...validStateBase,
      loopState: null,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loopState).toBeNull();
    }
  });

  it("defaults loopState to null when omitted", () => {
    const result = StateSchema.safeParse(validStateBase);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loopState).toBeNull();
    }
  });

  it("parses state with a valid loopState object", () => {
    const result = StateSchema.safeParse({
      ...validStateBase,
      loopState: {
        currentIteration: 2,
        maxIterations: 10,
        conditionMet: false,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loopState).toEqual({
        currentIteration: 2,
        maxIterations: 10,
        conditionMet: false,
      });
    }
  });

  it("createDefaultState returns loopState as null", () => {
    const state = createDefaultState();

    expect(state.loopState).toBeNull();
  });
});
