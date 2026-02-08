import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MessagingProvider, ApprovalResponse } from "../types.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setContext: vi.fn(),
  },
}));

type EventHandler = (...args: unknown[]) => unknown;

const {
  mockClientInstance,
  MockTextChannelClass,
  mockEmbedInstance,
} = vi.hoisted(() => {
  const MockTextChannelClass = class MockTextChannel {};

  const mockClientInstance = {
    on: vi.fn(),
    once: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    channels: { fetch: vi.fn() },
    isReady: vi.fn(() => true),
    user: { tag: "TestBot#0000" },
    destroy: vi.fn(),
  };

  const mockEmbedInstance = () => ({
    setTitle: vi.fn().mockReturnThis(),
    setDescription: vi.fn().mockReturnThis(),
    setColor: vi.fn().mockReturnThis(),
    setTimestamp: vi.fn().mockReturnThis(),
    setFooter: vi.fn().mockReturnThis(),
    addFields: vi.fn().mockReturnThis(),
    data: {},
  });

  return { mockClientInstance, MockTextChannelClass, mockEmbedInstance };
});

vi.mock("discord.js", () => {
  const MockEmbedBuilder = vi.fn(() => mockEmbedInstance());
  (MockEmbedBuilder as unknown as Record<string, unknown>).from = vi.fn(
    () => mockEmbedInstance()
  );

  return {
    Client: vi.fn(() => mockClientInstance),
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 3 },
    EmbedBuilder: MockEmbedBuilder,
    ButtonBuilder: vi.fn(() => ({
      setCustomId: vi.fn().mockReturnThis(),
      setLabel: vi.fn().mockReturnThis(),
      setEmoji: vi.fn().mockReturnThis(),
      setStyle: vi.fn().mockReturnThis(),
    })),
    ActionRowBuilder: vi.fn(() => ({
      addComponents: vi.fn().mockReturnThis(),
    })),
    ButtonStyle: { Success: 3, Danger: 4, Primary: 1 },
    ModalBuilder: vi.fn(() => ({
      setCustomId: vi.fn().mockReturnThis(),
      setTitle: vi.fn().mockReturnThis(),
      addComponents: vi.fn().mockReturnThis(),
    })),
    TextInputBuilder: vi.fn(() => ({
      setCustomId: vi.fn().mockReturnThis(),
      setLabel: vi.fn().mockReturnThis(),
      setStyle: vi.fn().mockReturnThis(),
      setRequired: vi.fn().mockReturnThis(),
      setPlaceholder: vi.fn().mockReturnThis(),
    })),
    TextInputStyle: { Paragraph: 2 },
    StringSelectMenuBuilder: vi.fn(() => ({
      setCustomId: vi.fn().mockReturnThis(),
      setPlaceholder: vi.fn().mockReturnThis(),
      addOptions: vi.fn().mockReturnThis(),
    })),
    ComponentType: {},
    TextChannel: MockTextChannelClass,
    Message: vi.fn(),
    ButtonInteraction: vi.fn(),
    ModalSubmitInteraction: vi.fn(),
    StringSelectMenuInteraction: vi.fn(),
    Interaction: vi.fn(),
  };
});

import { createDiscordProvider } from "../discord.js";

const AUTHORIZED_CHANNEL = "correct-channel-123";
const UNAUTHORIZED_CHANNEL = "wrong-channel-456";

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createMockTextChannel(): unknown {
  const channel = Object.create(MockTextChannelClass.prototype);
  channel.send = vi.fn().mockResolvedValue({
    id: "msg-1",
    embeds: [{ data: {} }],
    edit: vi.fn().mockResolvedValue(undefined),
  });
  return channel;
}

function captureInteractionHandler(): EventHandler {
  const onCalls = mockClientInstance.on.mock.calls as Array<
    [string, EventHandler]
  >;
  const interactionCall = onCalls.find(
    ([event]) => event === "interactionCreate"
  );
  if (!interactionCall) {
    throw new Error("interactionCreate handler not registered on mock client");
  }
  return interactionCall[1];
}

async function connectProvider(provider: MessagingProvider): Promise<void> {
  mockClientInstance.once.mockImplementation(
    (event: string, cb: EventHandler) => {
      if (event === "ready") {
        queueMicrotask(() => cb());
      }
      return mockClientInstance;
    }
  );

  const mockChannel = createMockTextChannel();
  mockClientInstance.channels.fetch.mockResolvedValue(mockChannel);

  await provider.connect();
}

function createMockButtonInteraction(overrides: {
  channelId: string;
  customId: string;
}) {
  return {
    channelId: overrides.channelId,
    customId: overrides.customId,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    user: { tag: "TestUser#1234" },
    reply: vi.fn().mockResolvedValue(undefined),
    message: {
      embeds: [{ data: {} }],
      edit: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createMockSelectInteraction(overrides: {
  channelId: string;
  customId: string;
  values: string[];
}) {
  return {
    channelId: overrides.channelId,
    customId: overrides.customId,
    values: overrides.values,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    user: { tag: "TestUser#1234" },
    reply: vi.fn().mockResolvedValue(undefined),
    message: {
      embeds: [{ data: {} }],
      edit: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createMockModalInteraction(overrides: {
  channelId: string;
  customId: string;
  fields: Record<string, string>;
}) {
  return {
    channelId: overrides.channelId,
    customId: overrides.customId,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    user: { tag: "TestUser#1234" },
    reply: vi.fn().mockResolvedValue(undefined),
    fields: {
      getTextInputValue: (fieldId: string) =>
        overrides.fields[fieldId] ?? "",
    },
    message: {
      embeds: [{ data: {} }],
      edit: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("Discord Security - Channel Authorization", () => {
  let provider: MessagingProvider;
  let onApproval: ReturnType<typeof vi.fn>;
  let onQuestionResponse: ReturnType<typeof vi.fn>;
  let interactionHandler: EventHandler;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockClientInstance.login.mockResolvedValue(undefined);
    mockClientInstance.isReady.mockReturnValue(true);

    provider = createDiscordProvider({
      botToken: "fake-bot-token",
      channelId: AUTHORIZED_CHANNEL,
    });

    onApproval = vi.fn<(response: ApprovalResponse) => void>();
    onQuestionResponse = vi.fn();
    provider.onApproval = onApproval;
    provider.onQuestionResponse = onQuestionResponse;

    await connectProvider(provider);
    interactionHandler = captureInteractionHandler();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.restoreAllMocks();
  });

  it("rejects button interactions from unauthorized channels", async () => {
    const unauthorizedInteraction = createMockButtonInteraction({
      channelId: UNAUTHORIZED_CHANNEL,
      customId: "approve_plan-1",
    });

    interactionHandler(unauthorizedInteraction);
    await flushPromises();

    expect(onApproval).not.toHaveBeenCalled();
  });

  it("rejects select menu interactions from unauthorized channels", async () => {
    const unauthorizedInteraction = createMockSelectInteraction({
      channelId: UNAUTHORIZED_CHANNEL,
      customId: "select_question-1",
      values: ["option-a"],
    });

    interactionHandler(unauthorizedInteraction);
    await flushPromises();

    expect(onQuestionResponse).not.toHaveBeenCalled();
  });

  it("rejects modal submit interactions from unauthorized channels", async () => {
    const unauthorizedInteraction = createMockModalInteraction({
      channelId: UNAUTHORIZED_CHANNEL,
      customId: "rejection_modal_plan-2",
      fields: { rejection_reason: "bad plan" },
    });

    interactionHandler(unauthorizedInteraction);
    await flushPromises();

    expect(onApproval).not.toHaveBeenCalled();
  });

  it("responds with ephemeral error for unauthorized button interaction", async () => {
    const unauthorizedInteraction = createMockButtonInteraction({
      channelId: UNAUTHORIZED_CHANNEL,
      customId: "approve_plan-1",
    });

    interactionHandler(unauthorizedInteraction);
    await flushPromises();

    expect(unauthorizedInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/unauthorized|not allowed|wrong channel/i),
        ephemeral: true,
      })
    );
  });

  it("logs warning for unauthorized channel interaction", async () => {
    const { logger } = await import("../../utils/logger.js");

    const unauthorizedInteraction = createMockButtonInteraction({
      channelId: UNAUTHORIZED_CHANNEL,
      customId: "approve_plan-1",
    });

    interactionHandler(unauthorizedInteraction);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unauthorized"),
      expect.objectContaining({
        channelId: UNAUTHORIZED_CHANNEL,
      })
    );
  });

  it("accepts button interactions from the authorized channel", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-1",
      ticketId: "TICK-1",
      ticketTitle: "Test plan",
      plan: "Plan content for approval",
    });

    const authorizedInteraction = createMockButtonInteraction({
      channelId: AUTHORIZED_CHANNEL,
      customId: "approve_plan-1",
    });

    interactionHandler(authorizedInteraction);
    await flushPromises();

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-1",
        approved: true,
      })
    );
  });

  it("accepts select menu interactions from the authorized channel", async () => {
    const authorizedInteraction = createMockSelectInteraction({
      channelId: AUTHORIZED_CHANNEL,
      customId: "select_question-1",
      values: ["option-a"],
    });

    interactionHandler(authorizedInteraction);
    await flushPromises();

    expect(authorizedInteraction.reply).toHaveBeenCalled();
  });

  it("accepts modal submit interactions from the authorized channel", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-3",
      ticketId: "TICK-3",
      ticketTitle: "Modal test plan",
      plan: "Plan content",
    });

    const authorizedInteraction = createMockModalInteraction({
      channelId: AUTHORIZED_CHANNEL,
      customId: "rejection_modal_plan-3",
      fields: { rejection_reason: "needs work" },
    });

    interactionHandler(authorizedInteraction);
    await flushPromises();

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-3",
        approved: false,
        rejectionReason: "needs work",
      })
    );
  });
});
