import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ZodError } from "zod";
import {
  SlackConfigSchema,
  DiscordConfigSchema,
  TelegramConfigSchema,
  MessagingConfigSchema,
  WebhookConfigSchema,
  TimeoutsSchema,
  ConfigSchema,
  ShellHookActionSchema,
  PromptHookActionSchema,
  HooksSchema,
  TicketSchema,
  TicketStatusSchema,
  StateSchema,
  PendingQuestionSchema,
  parseTicketsFile,
  safeParseTicketsFile,
  validateTicketDependencies,
  resolveEnvVars,
  resolveMessagingConfig,
} from "../schemas.js";

// =============================================================================
// Environment Variable Substitution Tests
// =============================================================================

describe("Environment Variable Substitution", () => {
  it("validates valid env var pattern ${VAR_NAME}", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${SLACK_BOT_TOKEN}",
      appToken: "${SLACK_APP_TOKEN}",
      channel: "general",
    });

    expect(result.success).toBe(true);
  });

  it("validates multiple env vars in one string", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${PREFIX}_${SUFFIX}",
      appToken: "${APP_TOKEN}",
      channel: "general",
    });

    expect(result.success).toBe(true);
  });

  it("rejects lowercase variable names", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${invalid}",
      appToken: "${APP_TOKEN}",
      channel: "general",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "Invalid environment variable syntax"
    );
  });

  it("rejects special characters in variable names", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${VAR-NAME}",
      appToken: "${APP_TOKEN}",
      channel: "general",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "Invalid environment variable syntax"
    );
  });

  it("accepts plain string without env var substitution", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "xoxb-plain-token",
      appToken: "xapp-plain-token",
      channel: "general",
    });

    expect(result.success).toBe(true);
  });

  it("rejects empty variable name in pattern", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${}",
      appToken: "${APP_TOKEN}",
      channel: "general",
    });

    expect(result.success).toBe(false);
  });

  it("accepts underscore-prefixed variable names", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${_PRIVATE_VAR}",
      appToken: "${__DUNDER_VAR}",
      channel: "general",
    });

    expect(result.success).toBe(true);
  });

  it("accepts variable names with numbers", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${VAR123}",
      appToken: "${TOKEN_V2}",
      channel: "general",
    });

    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Messaging Config Schema Tests
// =============================================================================

describe("Messaging Config Schemas", () => {
  it("validates SlackConfig successfully", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${SLACK_BOT_TOKEN}",
      appToken: "${SLACK_APP_TOKEN}",
      channel: "general",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("slack");
      expect(result.data.channel).toBe("general");
    }
  });

  it("validates DiscordConfig successfully", () => {
    const result = DiscordConfigSchema.safeParse({
      provider: "discord",
      botToken: "${DISCORD_BOT_TOKEN}",
      channelId: "123456789",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("discord");
      expect(result.data.channelId).toBe("123456789");
    }
  });

  it("validates TelegramConfig successfully", () => {
    const result = TelegramConfigSchema.safeParse({
      provider: "telegram",
      botToken: "${TELEGRAM_BOT_TOKEN}",
      chatId: "-100123456789",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("telegram");
      expect(result.data.chatId).toBe("-100123456789");
    }
  });

  it("rejects invalid provider type in discriminated union", () => {
    const result = MessagingConfigSchema.safeParse({
      provider: "invalid",
      botToken: "token",
    });

    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = SlackConfigSchema.safeParse({
      provider: "slack",
      botToken: "${TOKEN}",
    });

    expect(result.success).toBe(false);
  });

  it("validates env var syntax in tokens", () => {
    const result = DiscordConfigSchema.safeParse({
      provider: "discord",
      botToken: "${lowercase_invalid}",
      channelId: "123",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "Invalid environment variable syntax"
    );
  });
});

// =============================================================================
// Webhook, Timeouts, and Config Schema Tests
// =============================================================================

describe("WebhookConfigSchema", () => {
  it("applies default values correctly", () => {
    const result = WebhookConfigSchema.parse({});

    expect(result.enabled).toBe(false);
    expect(result.port).toBe(3847);
    expect(result.path).toBe("/planbot/webhook");
  });

  it("overrides defaults with provided values", () => {
    const result = WebhookConfigSchema.parse({
      enabled: true,
      port: 8080,
      path: "/custom/path",
    });

    expect(result.enabled).toBe(true);
    expect(result.port).toBe(8080);
    expect(result.path).toBe("/custom/path");
  });
});

describe("TimeoutsSchema", () => {
  it("applies default values correctly", () => {
    const result = TimeoutsSchema.parse({});

    expect(result.planGeneration).toBe(900000);
    expect(result.execution).toBe(1800000);
    expect(result.approval).toBe(86400000);
    expect(result.question).toBe(3600000);
  });

  it("overrides individual timeout values", () => {
    const result = TimeoutsSchema.parse({
      planGeneration: 60000,
    });

    expect(result.planGeneration).toBe(60000);
    expect(result.execution).toBe(1800000);
  });
});

describe("ConfigSchema", () => {
  it("applies all default values correctly", () => {
    const result = ConfigSchema.parse({});

    expect(result.model).toBeUndefined();
    expect(result.maxBudgetPerTicket).toBe(10);
    expect(result.maxRetries).toBe(3);
    expect(result.continueOnError).toBe(false);
    expect(result.autoApprove).toBe(false);
    expect(result.skipPermissions).toBe(false);
    expect(result.allowShellHooks).toBe(false);
    expect(result.webhook.enabled).toBe(false);
    expect(result.timeouts.planGeneration).toBe(900000);
  });

  it("rejects negative budget values", () => {
    const result = ConfigSchema.safeParse({
      maxBudgetPerTicket: -5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid model values", () => {
    const result = ConfigSchema.safeParse({
      model: "invalid-model",
    });

    expect(result.success).toBe(false);
  });

  it("rejects negative retry count", () => {
    const result = ConfigSchema.safeParse({
      maxRetries: -1,
    });

    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Hook Schema Tests
// =============================================================================

describe("Hook Schemas", () => {
  it("validates ShellHookAction successfully", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "shell",
      command: "npm test",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("shell");
      expect(result.data.command).toBe("npm test");
    }
  });

  it("validates PromptHookAction successfully", () => {
    const result = PromptHookActionSchema.safeParse({
      type: "prompt",
      command: "Review the changes",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("prompt");
      expect(result.data.command).toBe("Review the changes");
    }
  });

  it("rejects invalid hook type", () => {
    const result = ShellHookActionSchema.safeParse({
      type: "invalid",
      command: "echo test",
    });

    expect(result.success).toBe(false);
  });

  it("validates HooksSchema with all optional fields", () => {
    const result = HooksSchema.safeParse({
      beforeAll: [{ type: "shell", command: "npm install" }],
      afterEach: [{ type: "prompt", command: "Verify completion" }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.beforeAll).toHaveLength(1);
      expect(result.data.afterEach).toHaveLength(1);
      expect(result.data.beforeEach).toBeUndefined();
    }
  });
});

// =============================================================================
// Ticket and State Schema Tests
// =============================================================================

describe("Ticket Schemas", () => {
  it("validates TicketSchema with defaults applied", () => {
    const result = TicketSchema.parse({
      id: "TICKET-001",
      title: "Implement feature",
      description: "Add new functionality",
    });

    expect(result.id).toBe("TICKET-001");
    expect(result.priority).toBe(0);
    expect(result.status).toBe("pending");
  });

  it("validates all TicketStatusSchema enum values", () => {
    const validStatuses = [
      "pending",
      "planning",
      "awaiting_approval",
      "approved",
      "executing",
      "completed",
      "failed",
      "skipped",
    ];

    for (const status of validStatuses) {
      const result = TicketStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    }

    const invalidResult = TicketStatusSchema.safeParse("invalid_status");
    expect(invalidResult.success).toBe(false);
  });
});

describe("State Schemas", () => {
  it("validates StateSchema with defaults applied", () => {
    const now = new Date().toISOString();
    const result = StateSchema.parse({
      version: "1.0.0",
      currentTicketId: null,
      sessionId: null,
      startedAt: now,
      lastUpdatedAt: now,
    });

    expect(result.version).toBe("1.0.0");
    expect(result.currentPhase).toBe("idle");
    expect(result.pauseRequested).toBe(false);
    expect(result.pendingQuestions).toEqual([]);
  });

  it("validates PendingQuestionSchema datetime format", () => {
    const validQuestion = {
      id: "Q-001",
      ticketId: "TICKET-001",
      question: "What approach should we use?",
      askedAt: "2024-01-15T10:30:00.000Z",
    };

    const result = PendingQuestionSchema.safeParse(validQuestion);
    expect(result.success).toBe(true);

    const invalidQuestion = {
      ...validQuestion,
      askedAt: "not-a-datetime",
    };

    const invalidResult = PendingQuestionSchema.safeParse(invalidQuestion);
    expect(invalidResult.success).toBe(false);
  });
});

// =============================================================================
// Helper Function Tests
// =============================================================================

describe("parseTicketsFile", () => {
  it("parses valid input with defaults applied", () => {
    const input = {
      tickets: [
        {
          id: "TICKET-001",
          title: "Test ticket",
          description: "Test description",
        },
      ],
    };

    const result = parseTicketsFile(input);

    expect(result.config.model).toBeUndefined();
    expect(result.config.maxBudgetPerTicket).toBe(10);
    expect(result.tickets[0]?.status).toBe("pending");
    expect(result.tickets[0]?.priority).toBe(0);
  });

  it("throws ZodError for invalid input", () => {
    const invalidInput = {
      tickets: [
        {
          id: "",
          title: "",
          description: "",
        },
      ],
    };

    expect(() => parseTicketsFile(invalidInput)).toThrow(ZodError);
  });
});

describe("safeParseTicketsFile", () => {
  it("returns success object for valid input", () => {
    const input = {
      tickets: [
        {
          id: "TICKET-001",
          title: "Test ticket",
          description: "Test description",
        },
      ],
    };

    const result = safeParseTicketsFile(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tickets).toHaveLength(1);
    }
  });

  it("returns error object for invalid input", () => {
    const invalidInput = {
      tickets: "not-an-array",
    };

    const result = safeParseTicketsFile(invalidInput);

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(ZodError);
  });
});

describe("validateTicketDependencies", () => {
  it("validates tickets with valid dependencies", () => {
    const tickets = [
      {
        id: "A",
        title: "Ticket A",
        description: "First ticket",
        priority: 0,
        status: "pending" as const,
      },
      {
        id: "B",
        title: "Ticket B",
        description: "Depends on A",
        priority: 0,
        status: "pending" as const,
        dependencies: ["A"],
      },
      {
        id: "C",
        title: "Ticket C",
        description: "Depends on B",
        priority: 0,
        status: "pending" as const,
        dependencies: ["B"],
      },
    ];

    const result = validateTicketDependencies(tickets);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects missing dependency", () => {
    const tickets = [
      {
        id: "A",
        title: "Ticket A",
        description: "Depends on non-existent",
        priority: 0,
        status: "pending" as const,
        dependencies: ["NONEXISTENT"],
      },
    ];

    const result = validateTicketDependencies(tickets);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("non-existent ticket");
    expect(result.errors[0]).toContain("NONEXISTENT");
  });

  it("detects circular dependency A -> B -> C -> A", () => {
    const tickets = [
      {
        id: "A",
        title: "Ticket A",
        description: "Depends on C",
        priority: 0,
        status: "pending" as const,
        dependencies: ["C"],
      },
      {
        id: "B",
        title: "Ticket B",
        description: "Depends on A",
        priority: 0,
        status: "pending" as const,
        dependencies: ["A"],
      },
      {
        id: "C",
        title: "Ticket C",
        description: "Depends on B",
        priority: 0,
        status: "pending" as const,
        dependencies: ["B"],
      },
    ];

    const result = validateTicketDependencies(tickets);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Circular dependency"))).toBe(
      true
    );
  });
});

// =============================================================================
// resolveEnvVars and resolveMessagingConfig Tests
// =============================================================================

describe("resolveEnvVars", () => {
  beforeEach(() => {
    vi.stubEnv("TEST_VAR", "resolved_value");
    vi.stubEnv("ANOTHER_VAR", "another_value");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("substitutes env vars correctly", () => {
    const result = resolveEnvVars("prefix_${TEST_VAR}_suffix");

    expect(result).toBe("prefix_resolved_value_suffix");
  });

  it("substitutes multiple env vars in one string", () => {
    const result = resolveEnvVars("${TEST_VAR}_${ANOTHER_VAR}");

    expect(result).toBe("resolved_value_another_value");
  });

  it("throws on missing env var", () => {
    expect(() => resolveEnvVars("${MISSING_VAR}")).toThrow(
      "Environment variable MISSING_VAR is not set"
    );
  });

  it("handles empty env var value", () => {
    vi.stubEnv("EMPTY_VAR", "");

    const result = resolveEnvVars("prefix_${EMPTY_VAR}_suffix");

    expect(result).toBe("prefix__suffix");
  });
});

describe("resolveMessagingConfig", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_BOT", "xoxb-slack-bot");
    vi.stubEnv("SLACK_APP", "xapp-slack-app");
    vi.stubEnv("DISCORD_TOKEN", "discord-bot-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves Slack config tokens", () => {
    const config = {
      provider: "slack" as const,
      botToken: "${SLACK_BOT}",
      appToken: "${SLACK_APP}",
      channel: "general",
    };

    const resolved = resolveMessagingConfig(config);

    expect(resolved.botToken).toBe("xoxb-slack-bot");
    expect(resolved.appToken).toBe("xapp-slack-app");
    expect(resolved.channel).toBe("general");
  });

  it("resolves Discord config tokens", () => {
    const config = {
      provider: "discord" as const,
      botToken: "${DISCORD_TOKEN}",
      channelId: "123456789",
    };

    const resolved = resolveMessagingConfig(config);

    expect(resolved.botToken).toBe("discord-bot-token");
    expect(resolved.channelId).toBe("123456789");
  });
});
