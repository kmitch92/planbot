import { describe, it, expect } from "vitest";
import {
  TicketSchema,
  ShellHookActionSchema,
  ShellConditionSchema,
} from "../schemas.js";

// =============================================================================
// TicketSchema cwd Field Validation
// =============================================================================

describe("TicketSchema cwd field", () => {
  const validTicketBase = {
    id: "ticket-1",
    title: "Implement feature",
    description: "Build the feature",
  };

  it("accepts ticket without cwd field (backward compatibility)", () => {
    const result = TicketSchema.safeParse(validTicketBase);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBeUndefined();
    }
  });

  it("accepts ticket with valid relative cwd path", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "services/auth-service",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("services/auth-service");
    }
  });

  it("accepts single directory cwd", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "backend",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("backend");
    }
  });

  it("accepts deeply nested cwd path", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "packages/core/src/lib/utils",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("packages/core/src/lib/utils");
    }
  });

  it("rejects cwd with path traversal (..)", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "../parent-dir",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Path must not contain ..");
    }
  });

  it("rejects cwd with embedded path traversal", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "services/../../../etc",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Path must not contain ..");
    }
  });

  it("rejects cwd with double dot anywhere in path", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "valid/path/with..dots",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Path must not contain ..");
    }
  });

  it("rejects empty cwd string", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects cwd exceeding max length (500 characters)", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "a".repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it("accepts cwd at max length boundary (500 characters)", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "a".repeat(500),
    });

    expect(result.success).toBe(true);
  });

  it("accepts cwd with hyphens and underscores", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: "my-service_v2/src-code",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("my-service_v2/src-code");
    }
  });

  it("accepts cwd with dots in directory names (not traversal)", () => {
    const result = TicketSchema.safeParse({
      ...validTicketBase,
      cwd: ".planbot/assets",
    });

    expect(result.success).toBe(true);
  });
});

// =============================================================================
// ShellHookActionSchema cwd Field Validation
// =============================================================================

describe("ShellHookActionSchema cwd field", () => {
  it("accepts shell hook without cwd field (optional)", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBeUndefined();
    }
  });

  it("accepts shell hook with valid cwd path", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      cwd: "packages/frontend",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("packages/frontend");
    }
  });

  it("rejects shell hook with path traversal in cwd", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      cwd: "../outside-project",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Path must not contain ..");
    }
  });

  it("rejects shell hook with embedded path traversal in cwd", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      cwd: "valid/../../escape",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Path must not contain ..");
    }
  });

  it("rejects empty cwd string in shell hook", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      cwd: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects cwd exceeding max length in shell hook", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
      cwd: "a".repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it("accepts cwd with nested path in shell hook", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "make build",
      cwd: "services/api/src/handlers",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("services/api/src/handlers");
    }
  });
});

// =============================================================================
// ShellConditionSchema cwd Field Validation
// =============================================================================

describe("ShellConditionSchema cwd field", () => {
  it("accepts shell condition without cwd field (optional)", () => {
    const result = ShellConditionSchema.safeParse({
      type: "shell",
      command: "test -f done.txt",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBeUndefined();
    }
  });

  it("accepts shell condition with valid cwd path", () => {
    const result = ShellConditionSchema.safeParse({
      type: "shell",
      command: "npm test -- --coverage",
      cwd: "packages/core",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("packages/core");
    }
  });

  it("rejects shell condition with path traversal in cwd", () => {
    const result = ShellConditionSchema.safeParse({
      type: "shell",
      command: "cat /etc/passwd",
      cwd: "../../etc",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Path must not contain ..");
    }
  });

  it("rejects shell condition with embedded path traversal", () => {
    const result = ShellConditionSchema.safeParse({
      type: "shell",
      command: "test -f marker",
      cwd: "safe/path/../../../etc",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Path must not contain ..");
    }
  });

  it("rejects empty cwd string in shell condition", () => {
    const result = ShellConditionSchema.safeParse({
      type: "shell",
      command: "test -f done.txt",
      cwd: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects cwd exceeding max length in shell condition", () => {
    const result = ShellConditionSchema.safeParse({
      type: "shell",
      command: "test -f done.txt",
      cwd: "a".repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it("accepts deeply nested cwd in shell condition", () => {
    const result = ShellConditionSchema.safeParse({
      type: "shell",
      command: "npm run lint",
      cwd: "apps/web/src/components/forms",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("apps/web/src/components/forms");
    }
  });
});

// =============================================================================
// Integration: Full Ticket with Loop and Hooks containing cwd
// =============================================================================

describe("Full ticket with cwd in nested structures", () => {
  it("accepts ticket with cwd in ticket, hooks, and loop condition", () => {
    const result = TicketSchema.safeParse({
      id: "ticket-1",
      title: "Complex ticket",
      description: "A ticket with cwd everywhere",
      cwd: "services/main",
      hooks: {
        beforeEach: [
          { type: "shell", command: "npm run setup", cwd: "packages/setup" },
        ],
        afterEach: [
          { type: "shell", command: "npm run cleanup" },
        ],
      },
      loop: {
        goal: "All tests pass",
        condition: {
          type: "shell",
          command: "npm test",
          cwd: "packages/tests",
        },
        maxIterations: 5,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cwd).toBe("services/main");
      expect(result.data.hooks?.beforeEach?.[0]).toMatchObject({
        type: "shell",
        command: "npm run setup",
        cwd: "packages/setup",
      });
      expect(result.data.loop?.condition).toMatchObject({
        type: "shell",
        command: "npm test",
        cwd: "packages/tests",
      });
    }
  });

  it("rejects ticket when hook cwd contains path traversal", () => {
    const result = TicketSchema.safeParse({
      id: "ticket-1",
      title: "Bad hook cwd",
      description: "Hook tries to escape",
      cwd: "services/main",
      hooks: {
        beforeEach: [
          { type: "shell", command: "cat secrets", cwd: "../../../secrets" },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects ticket when loop condition cwd contains path traversal", () => {
    const result = TicketSchema.safeParse({
      id: "ticket-1",
      title: "Bad loop cwd",
      description: "Loop condition tries to escape",
      cwd: "services/main",
      loop: {
        goal: "Escape sandbox",
        condition: {
          type: "shell",
          command: "test -f /etc/passwd",
          cwd: "../../../etc",
        },
        maxIterations: 1,
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts prompt hook/condition without cwd (prompts have no cwd)", () => {
    const result = TicketSchema.safeParse({
      id: "ticket-1",
      title: "Prompt based",
      description: "Uses prompt hooks and conditions",
      hooks: {
        onComplete: [
          { type: "prompt", command: "Verify the implementation" },
        ],
      },
      loop: {
        goal: "Coverage above 80%",
        condition: {
          type: "prompt",
          command: "Is coverage above 80%?",
        },
        maxIterations: 5,
      },
    });

    expect(result.success).toBe(true);
  });
});
