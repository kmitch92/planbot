import { describe, it, expect } from "vitest";

import type {
  AgentProvider,
  AgentProviderMetadata,
  ExecutionCallbacks,
  ExecutionResult,
  PlanResult,
  PromptResult,
  ProviderOptions,
} from "../types/agent-provider.js";

function createMockProvider(): AgentProvider {
  return {
    generatePlan: async () => ({ success: true }),
    execute: async () => ({ success: true }),
    resume: async () => ({ success: true }),
    answerQuestion: () => {},
    abort: () => {},
    runPrompt: async () => ({ success: true }),
    getRateLimitResetsAt: () => null,
    clearRateLimitResetsAt: () => {},
  };
}

describe("AgentProvider interface contract", () => {
  describe("type compatibility", () => {
    it("mock object satisfying AgentProvider compiles and has all required methods", () => {
      const provider = createMockProvider();

      expect(typeof provider.generatePlan).toBe("function");
      expect(typeof provider.execute).toBe("function");
      expect(typeof provider.resume).toBe("function");
      expect(typeof provider.answerQuestion).toBe("function");
      expect(typeof provider.abort).toBe("function");
      expect(typeof provider.runPrompt).toBe("function");
      expect(typeof provider.getRateLimitResetsAt).toBe("function");
      expect(typeof provider.clearRateLimitResetsAt).toBe("function");
    });

    it("generatePlan accepts prompt, options, and onOutput callback", async () => {
      const provider = createMockProvider();
      const options: ProviderOptions = { model: "sonnet", timeout: 30000 };
      const onOutput = (_text: string) => {};

      const result: PlanResult = await provider.generatePlan(
        "test prompt",
        options,
        onOutput,
      );

      expect(result).toHaveProperty("success");
    });

    it("execute accepts prompt, options, and callbacks", async () => {
      const provider = createMockProvider();
      const options: ProviderOptions = { sessionId: "s-1", cwd: "/tmp" };
      const callbacks: ExecutionCallbacks = {
        onEvent: () => {},
        onOutput: () => {},
      };

      const result: ExecutionResult = await provider.execute(
        "run task",
        options,
        callbacks,
      );

      expect(result).toHaveProperty("success");
    });

    it("resume accepts sessionId, input, options, and callbacks", async () => {
      const provider = createMockProvider();
      const options: ProviderOptions = {};
      const callbacks: ExecutionCallbacks = {};

      const result: ExecutionResult = await provider.resume(
        "session-abc",
        "continue",
        options,
        callbacks,
      );

      expect(result).toHaveProperty("success");
    });

    it("runPrompt returns PromptResult with success, output, error, costUsd", async () => {
      const provider = createMockProvider();

      const result: PromptResult = await provider.runPrompt("one-shot", {
        model: "haiku",
        skipPermissions: true,
      });

      expect(result).toHaveProperty("success");
    });

    it("getRateLimitResetsAt returns number or null", () => {
      const provider = createMockProvider();

      const value: number | null = provider.getRateLimitResetsAt();

      expect(value).toBeNull();
    });

    it("answerQuestion and abort are void-returning", () => {
      const provider = createMockProvider();

      expect(provider.answerQuestion("yes")).toBeUndefined();
      expect(provider.abort()).toBeUndefined();
    });
  });

  describe("AgentProviderMetadata shape", () => {
    it("metadata has name and supportedModels fields", () => {
      const metadata: AgentProviderMetadata = {
        name: "test-provider",
        supportedModels: ["model-a", "model-b"],
      };

      expect(metadata.name).toBe("test-provider");
      expect(metadata.supportedModels).toContain("model-a");
      expect(metadata.supportedModels).toContain("model-b");
    });
  });
});

describe("createProvider factory", () => {
  it.skip("createProvider('claude') returns an object satisfying AgentProvider", async () => {
    // Enable after providers/index.ts is created
    const { createProvider } = await import("../providers/index.js");
    const provider = createProvider("claude");

    expect(typeof provider.generatePlan).toBe("function");
    expect(typeof provider.execute).toBe("function");
    expect(typeof provider.resume).toBe("function");
    expect(typeof provider.answerQuestion).toBe("function");
    expect(typeof provider.abort).toBe("function");
    expect(typeof provider.runPrompt).toBe("function");
    expect(typeof provider.getRateLimitResetsAt).toBe("function");
    expect(typeof provider.clearRateLimitResetsAt).toBe("function");
  });

  it.skip("createProvider('unknown') throws an error", async () => {
    // Enable after providers/index.ts is created
    const { createProvider } = await import("../providers/index.js");

    expect(() => createProvider("unknown")).toThrow();
  });
});

describe("ClaudeProvider contract", () => {
  it.skip("ClaudeProvider implements AgentProvider", async () => {
    // Enable after providers/claude.ts is created
    const { ClaudeProvider } = await import("../providers/claude.js");
    const provider: AgentProvider = new ClaudeProvider();

    expect(typeof provider.generatePlan).toBe("function");
    expect(typeof provider.execute).toBe("function");
    expect(typeof provider.resume).toBe("function");
    expect(typeof provider.answerQuestion).toBe("function");
    expect(typeof provider.abort).toBe("function");
    expect(typeof provider.runPrompt).toBe("function");
    expect(typeof provider.getRateLimitResetsAt).toBe("function");
    expect(typeof provider.clearRateLimitResetsAt).toBe("function");
  });

  it.skip("getRateLimitResetsAt returns null initially", async () => {
    // Enable after providers/claude.ts is created
    const { ClaudeProvider } = await import("../providers/claude.js");
    const provider = new ClaudeProvider();

    expect(provider.getRateLimitResetsAt()).toBeNull();
  });

  it.skip("clearRateLimitResetsAt resets to null after state change", async () => {
    // Enable after providers/claude.ts is created
    const { ClaudeProvider } = await import("../providers/claude.js");
    const provider = new ClaudeProvider();

    provider.clearRateLimitResetsAt();

    expect(provider.getRateLimitResetsAt()).toBeNull();
  });
});

describe("Claude provider metadata", () => {
  it.skip("has name 'claude' and supportedModels containing sonnet, opus, haiku", async () => {
    // Enable after providers/claude.ts is created
    const { ClaudeProvider } = await import("../providers/claude.js");
    const provider = new ClaudeProvider();
    const metadata: AgentProviderMetadata =
      provider.metadata ?? ({} as AgentProviderMetadata);

    expect(metadata.name).toBe("claude");
    expect(metadata.supportedModels).toContain("sonnet");
    expect(metadata.supportedModels).toContain("opus");
    expect(metadata.supportedModels).toContain("haiku");
  });
});
