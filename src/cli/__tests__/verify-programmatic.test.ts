import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  buildVerifyPrompt,
  runVerification,
  type RunVerificationOptions,
  type RunVerificationResult,
} from "../commands/verify.js";
import type { Ticket } from "../../core/schemas.js";
import type {
  AgentProvider,
  ExecutionCallbacks,
  ExecutionResult,
  ProviderOptions,
} from "../../core/types/agent-provider.js";

// ============================================================================
// Helpers
// ============================================================================

function makeTicket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    id: overrides.id,
    title: overrides.title ?? `Title for ${overrides.id}`,
    description: overrides.description ?? `Description for ${overrides.id}`,
    priority: 0,
    status: "pending",
    complete: false,
    ...overrides,
  } as Ticket;
}

interface MockProviderState {
  executeCalls: Array<{
    prompt: string;
    options: ProviderOptions;
    callbacks: ExecutionCallbacks;
  }>;
  executeImpl: (
    prompt: string,
    options: ProviderOptions,
    callbacks: ExecutionCallbacks,
  ) => Promise<ExecutionResult>;
}

function createMockProvider(
  executeImpl?: (
    prompt: string,
    options: ProviderOptions,
    callbacks: ExecutionCallbacks,
  ) => Promise<ExecutionResult>,
): AgentProvider & { __state: MockProviderState } {
  const state: MockProviderState = {
    executeCalls: [],
    executeImpl:
      executeImpl ??
      (async () => ({ success: true, sessionId: "test-session" })),
  };

  const provider: AgentProvider & { __state: MockProviderState } = {
    __state: state,
    metadata: {
      name: "mock",
      supportedModels: ["sonnet"] as const,
    },
    generatePlan: vi.fn().mockResolvedValue({ success: true }),
    execute: vi.fn(
      async (
        prompt: string,
        options: ProviderOptions,
        callbacks: ExecutionCallbacks,
      ) => {
        state.executeCalls.push({ prompt, options, callbacks });
        return state.executeImpl(prompt, options, callbacks);
      },
    ),
    resume: vi.fn().mockResolvedValue({ success: true }),
    answerQuestion: vi.fn(),
    abort: vi.fn(),
    runPrompt: vi.fn().mockResolvedValue({ success: true }),
    getRateLimitResetsAt: vi.fn().mockReturnValue(null),
    clearRateLimitResetsAt: vi.fn(),
  };

  return provider;
}

function emitAssistant(
  callbacks: ExecutionCallbacks,
  message: string,
): void {
  callbacks.onEvent?.({ type: "assistant", message });
}

// ============================================================================
// buildVerifyPrompt — interactive flag
// ============================================================================

describe("buildVerifyPrompt — interactive option", () => {
  const sampleTicket: Ticket = makeTicket({
    id: "T-1",
    title: "Sample",
    description: "Demo",
    acceptanceCriteria: ["First criterion", "Second criterion"],
  });

  it("includes AskUserQuestion confirmation step by default (no options)", () => {
    const prompt = buildVerifyPrompt([sampleTicket]);
    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toMatch(/^\s*5\./m);
  });

  it("includes AskUserQuestion step when interactive: true", () => {
    const prompt = buildVerifyPrompt([sampleTicket], { interactive: true });
    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toMatch(/^\s*5\./m);
  });

  it("omits AskUserQuestion and user-confirmation step when interactive: false", () => {
    const prompt = buildVerifyPrompt([sampleTicket], { interactive: false });
    expect(prompt).not.toContain("AskUserQuestion");
    expect(prompt).not.toContain("Do you confirm these results");
    // Still has token-protocol section and ticket data
    expect(prompt).toContain("[VERIFY_START");
    expect(prompt).toContain("[CRITERION");
    expect(prompt).toContain("[VERIFY_END");
    expect(prompt).toContain("[VERIFY_COMPLETE");
  });

  it("preserves ticket data sections when interactive: false", () => {
    const prompt = buildVerifyPrompt([sampleTicket], { interactive: false });
    expect(prompt).toContain("### Ticket: T-1");
    expect(prompt).toContain("**Title**: Sample");
    expect(prompt).toContain("**Description**: Demo");
    expect(prompt).toContain("0. First criterion");
    expect(prompt).toContain("1. Second criterion");
  });
});

// ============================================================================
// runVerification — programmatic API
// ============================================================================

describe("runVerification", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        throw new Error(`process.exit called with code ${_code}`);
      }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("returns empty results and does not call provider when no tickets have acceptance criteria", async () => {
    const provider = createMockProvider();
    const tickets: Ticket[] = [
      makeTicket({ id: "A" }),
      makeTicket({ id: "B" }),
    ];

    const opts: RunVerificationOptions = {
      tickets,
      provider,
      cwd: "/tmp/test",
    };
    const result: RunVerificationResult = await runVerification(opts);

    expect(result).toEqual({ results: [], success: true });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("filters to verifiable tickets and passes only those to the provider prompt", async () => {
    const provider = createMockProvider(async (_p, _o, callbacks) => {
      emitAssistant(
        callbacks,
        '[VERIFY_START ticketId="VERIFY-ME"]\n' +
          '[CRITERION index=0 status="PASS" reason="ok"]\n' +
          '[VERIFY_END ticketId="VERIFY-ME" result="PASS"]\n',
      );
      return { success: true, sessionId: "s-1" };
    });

    const tickets: Ticket[] = [
      makeTicket({ id: "NO-CRIT-A" }),
      makeTicket({
        id: "VERIFY-ME",
        title: "Should be verified",
        acceptanceCriteria: ["The thing works"],
      }),
      makeTicket({ id: "NO-CRIT-B" }),
    ];

    const result = await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
    });

    expect(provider.execute).toHaveBeenCalledTimes(1);
    const promptArg = provider.__state.executeCalls[0]!.prompt;
    expect(promptArg).toContain("### Ticket: VERIFY-ME");
    expect(promptArg).not.toContain("### Ticket: NO-CRIT-A");
    expect(promptArg).not.toContain("### Ticket: NO-CRIT-B");

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.ticketId).toBe("VERIFY-ME");
  });

  it("streams agent text into the tracker and returns parsed results", async () => {
    const provider = createMockProvider(async (_p, _o, callbacks) => {
      emitAssistant(
        callbacks,
        '[VERIFY_START ticketId="t-1"]\n' +
          '[CRITERION index=0 status="PASS" reason="ok"]\n' +
          '[VERIFY_END ticketId="t-1" result="PASS"]\n',
      );
      return { success: true, sessionId: "s-1" };
    });

    const tickets: Ticket[] = [
      makeTicket({
        id: "t-1",
        title: "Ticket One",
        acceptanceCriteria: ["does the thing"],
      }),
    ];

    const result = await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    const v = result.results[0]!;
    expect(v.ticketId).toBe("t-1");
    expect(v.result).toBe("PASS");
    expect(v.criteria).toHaveLength(1);
    expect(v.criteria[0]!.status).toBe("PASS");
    expect(v.criteria[0]!.index).toBe(0);
  });

  it("enriches criterion text from ticket acceptance criteria when agent emits no text field", async () => {
    const provider = createMockProvider(async (_p, _o, callbacks) => {
      emitAssistant(
        callbacks,
        '[VERIFY_START ticketId="t-1"]\n' +
          '[CRITERION index=0 status="PASS" reason="ok"]\n' +
          '[CRITERION index=1 status="FAIL" reason="missing"]\n' +
          '[VERIFY_END ticketId="t-1" result="PARTIAL"]\n',
      );
      return { success: true, sessionId: "s-1" };
    });

    const tickets: Ticket[] = [
      makeTicket({
        id: "t-1",
        title: "Enrichment Test",
        acceptanceCriteria: [
          "Criterion zero text from ticket",
          "Criterion one text from ticket",
        ],
      }),
    ];

    const result = await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
    });

    expect(result.results).toHaveLength(1);
    const v = result.results[0]!;
    expect(v.ticketTitle).toBe("Enrichment Test");
    expect(v.criteria).toHaveLength(2);
    expect(v.criteria[0]!.text).toBe("Criterion zero text from ticket");
    expect(v.criteria[1]!.text).toBe("Criterion one text from ticket");
  });

  it("uses interactive: false by default — prompt does not contain AskUserQuestion", async () => {
    const provider = createMockProvider();
    const tickets: Ticket[] = [
      makeTicket({
        id: "t-1",
        acceptanceCriteria: ["a"],
      }),
    ];

    await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
    });

    expect(provider.execute).toHaveBeenCalledTimes(1);
    const promptArg = provider.__state.executeCalls[0]!.prompt;
    expect(promptArg).not.toContain("AskUserQuestion");
  });

  it("includes AskUserQuestion in prompt when interactive: true is passed", async () => {
    const provider = createMockProvider();
    const tickets: Ticket[] = [
      makeTicket({
        id: "t-1",
        acceptanceCriteria: ["a"],
      }),
    ];

    await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
      interactive: true,
    });

    expect(provider.execute).toHaveBeenCalledTimes(1);
    const promptArg = provider.__state.executeCalls[0]!.prompt;
    expect(promptArg).toContain("AskUserQuestion");
  });

  it("does not call process.exit", async () => {
    const provider = createMockProvider();
    const tickets: Ticket[] = [
      makeTicket({
        id: "t-1",
        acceptanceCriteria: ["a"],
      }),
    ];

    await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
    });

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("passes cwd and timeout into provider.execute options", async () => {
    const provider = createMockProvider();
    const tickets: Ticket[] = [
      makeTicket({
        id: "t-1",
        acceptanceCriteria: ["a"],
      }),
    ];

    await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
      timeout: 60000,
    });

    expect(provider.execute).toHaveBeenCalledTimes(1);
    const optsArg = provider.__state.executeCalls[0]!.options;
    expect(optsArg.cwd).toBe("/tmp/test");
    expect(optsArg.timeout).toBe(60000);
  });

  it("returns success: false but still returns tracker results when provider.execute fails", async () => {
    const provider = createMockProvider(async (_p, _o, callbacks) => {
      emitAssistant(
        callbacks,
        '[VERIFY_START ticketId="t-1"]\n' +
          '[CRITERION index=0 status="FAIL" reason="broken"]\n' +
          '[VERIFY_END ticketId="t-1" result="FAIL"]\n',
      );
      return { success: false, error: "agent crashed" };
    });

    const tickets: Ticket[] = [
      makeTicket({
        id: "t-1",
        title: "Failing run",
        acceptanceCriteria: ["the thing"],
      }),
    ];

    const result = await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
    });

    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.ticketId).toBe("t-1");
    expect(result.results[0]!.result).toBe("FAIL");
  });

  it("aggregates results across multiple tickets in a single execution", async () => {
    const provider = createMockProvider(async (_p, _o, callbacks) => {
      emitAssistant(
        callbacks,
        '[VERIFY_START ticketId="t-1"]\n' +
          '[CRITERION index=0 status="PASS" reason="ok"]\n' +
          '[VERIFY_END ticketId="t-1" result="PASS"]\n' +
          '[VERIFY_START ticketId="t-2"]\n' +
          '[CRITERION index=0 status="FAIL" reason="nope"]\n' +
          '[VERIFY_END ticketId="t-2" result="FAIL"]\n',
      );
      return { success: true, sessionId: "s-1" };
    });

    const tickets: Ticket[] = [
      makeTicket({
        id: "t-1",
        title: "First",
        acceptanceCriteria: ["a"],
      }),
      makeTicket({
        id: "t-2",
        title: "Second",
        acceptanceCriteria: ["b"],
      }),
    ];

    const result = await runVerification({
      tickets,
      provider,
      cwd: "/tmp/test",
    });

    expect(result.results).toHaveLength(2);
    const ids = result.results.map((r) => r.ticketId).sort();
    expect(ids).toEqual(["t-1", "t-2"]);
    const t1 = result.results.find((r) => r.ticketId === "t-1");
    const t2 = result.results.find((r) => r.ticketId === "t-2");
    expect(t1?.result).toBe("PASS");
    expect(t2?.result).toBe("FAIL");
  });
});
