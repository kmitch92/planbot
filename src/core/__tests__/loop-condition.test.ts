import { describe, it, expect, vi } from "vitest";
import { evaluateCondition } from "../loop-condition.js";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("evaluateCondition — shell", () => {
  const baseContext = { ticketId: "test-1", iteration: 0, goal: "test goal" };
  const baseOptions = { allowShellHooks: true };

  it("returns met: true when command exits 0", async () => {
    const result = await evaluateCondition(
      { type: "shell", command: "exit 0" },
      baseContext,
      baseOptions
    );
    expect(result.met).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns met: false when command exits non-zero", async () => {
    const result = await evaluateCondition(
      { type: "shell", command: "exit 1" },
      baseContext,
      baseOptions
    );
    expect(result.met).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("captures stdout output", async () => {
    const result = await evaluateCondition(
      { type: "shell", command: 'echo "hello world"' },
      baseContext,
      baseOptions
    );
    expect(result.met).toBe(true);
    expect(result.output).toBe("hello world");
  });

  it("returns error when shell hooks are disabled", async () => {
    const result = await evaluateCondition(
      { type: "shell", command: "exit 0" },
      baseContext,
      { allowShellHooks: false }
    );
    expect(result.met).toBe(false);
    expect(result.error).toContain("disabled");
  });

  it("handles timeout", async () => {
    const result = await evaluateCondition(
      { type: "shell", command: "sleep 10" },
      baseContext,
      { allowShellHooks: true, timeout: 100 }
    );
    expect(result.met).toBe(false);
    expect(result.error).toContain("timed out");
  }, 15000);
});

describe("evaluateCondition — prompt", () => {
  const baseContext = { ticketId: "test-1", iteration: 0, goal: "Achieve 80% coverage" };

  it("returns met: true when claudeRunner responds YES", async () => {
    const claudeRunner = vi.fn().mockResolvedValue({
      success: true,
      output: "YES\nCoverage is at 85%.",
    });

    const result = await evaluateCondition(
      { type: "prompt", command: "Is coverage above 80%?" },
      baseContext,
      { allowShellHooks: false, claudeRunner }
    );
    expect(result.met).toBe(true);
    expect(claudeRunner).toHaveBeenCalledOnce();
  });

  it("returns met: false when claudeRunner responds NO", async () => {
    const claudeRunner = vi.fn().mockResolvedValue({
      success: true,
      output: "NO\nCoverage is only 60%.",
    });

    const result = await evaluateCondition(
      { type: "prompt", command: "Is coverage above 80%?" },
      baseContext,
      { allowShellHooks: false, claudeRunner }
    );
    expect(result.met).toBe(false);
  });

  it("returns error when no claudeRunner provided", async () => {
    const result = await evaluateCondition(
      { type: "prompt", command: "Is it done?" },
      baseContext,
      { allowShellHooks: false }
    );
    expect(result.met).toBe(false);
    expect(result.error).toContain("claudeRunner");
  });

  it("returns met: false when claudeRunner fails", async () => {
    const claudeRunner = vi.fn().mockResolvedValue({
      success: false,
      error: "Claude failed",
    });

    const result = await evaluateCondition(
      { type: "prompt", command: "Is it done?" },
      baseContext,
      { allowShellHooks: false, claudeRunner }
    );
    expect(result.met).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("passes goal and iteration context in the prompt", async () => {
    const claudeRunner = vi.fn().mockResolvedValue({
      success: true,
      output: "NO",
    });

    await evaluateCondition(
      { type: "prompt", command: "Check coverage" },
      { ticketId: "t1", iteration: 3, goal: "80% coverage" },
      { allowShellHooks: false, claudeRunner }
    );

    const prompt = claudeRunner.mock.calls[0][0];
    expect(prompt).toContain("80% coverage");
    expect(prompt).toContain("4"); // iteration + 1
  });
});
