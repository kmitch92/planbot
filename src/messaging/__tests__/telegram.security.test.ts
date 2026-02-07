import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type TelegramBot from "node-telegram-bot-api";
import { createTelegramProvider } from "../telegram.js";
import type {
  MessagingProvider,
  ApprovalResponse,
  QuestionResponse,
} from "../types.js";

vi.mock("node-telegram-bot-api", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      deleteWebHook: vi.fn().mockResolvedValue(true),
      getUpdates: vi.fn().mockResolvedValue([]),
      startPolling: vi.fn().mockResolvedValue(undefined),
      stopPolling: vi.fn().mockResolvedValue(undefined),
      removeAllListeners: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      getMe: vi.fn().mockResolvedValue({
        id: 123,
        is_bot: true,
        first_name: "TestBot",
      }),
    })),
  };
});

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setContext: vi.fn(),
  },
}));

const AUTHORIZED_CHAT_ID = "12345";
const UNAUTHORIZED_CHAT_ID = 99999;

type ProviderWithCallbacks = MessagingProvider & {
  onApproval?: (response: ApprovalResponse) => void;
  onQuestionResponse?: (response: QuestionResponse) => void;
};

function createCallbackQuery(
  overrides: Partial<{
    id: string;
    data: string;
    chatId: number;
    fromId: number;
    fromUsername: string;
    messageId: number;
  }> = {}
): TelegramBot.CallbackQuery {
  const {
    id = "cbq-1",
    data = "approve:plan-1",
    chatId = Number(AUTHORIZED_CHAT_ID),
    fromId = 42,
    fromUsername = "testuser",
    messageId = 100,
  } = overrides;

  return {
    id,
    from: {
      id: fromId,
      is_bot: false,
      first_name: "Test",
      username: fromUsername,
    },
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: chatId,
        type: "private" as const,
      },
    },
    chat_instance: "test-instance",
    data,
  };
}

function createMessage(
  overrides: Partial<{
    text: string;
    chatId: number;
    fromId: number;
    fromUsername: string;
    messageId: number;
    replyToMessageId: number;
  }> = {}
): TelegramBot.Message {
  const {
    text = "Some rejection reason",
    chatId = Number(AUTHORIZED_CHAT_ID),
    fromId = 42,
    fromUsername = "testuser",
    messageId = 200,
    replyToMessageId,
  } = overrides;

  const msg: TelegramBot.Message = {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: chatId,
      type: "private" as const,
    },
    from: {
      id: fromId,
      is_bot: false,
      first_name: "Test",
      username: fromUsername,
    },
    text,
  };

  if (replyToMessageId !== undefined) {
    msg.reply_to_message = {
      message_id: replyToMessageId,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: chatId,
        type: "private" as const,
      },
    };
  }

  return msg;
}

function extractHandlers(provider: ProviderWithCallbacks): {
  callbackQuery: (query: TelegramBot.CallbackQuery) => Promise<void>;
  message: (msg: TelegramBot.Message) => Promise<void>;
} {
  const bot = (provider as unknown as { bot: { on: ReturnType<typeof vi.fn> } })
    .bot;

  const callbackQueryCall = bot.on.mock.calls.find(
    (call: unknown[]) => call[0] === "callback_query"
  );
  const messageCall = bot.on.mock.calls.find(
    (call: unknown[]) => call[0] === "message"
  );

  if (!callbackQueryCall || !messageCall) {
    throw new Error("Handlers not registered -- was connect() called?");
  }

  return {
    callbackQuery: callbackQueryCall[1] as (
      query: TelegramBot.CallbackQuery
    ) => Promise<void>,
    message: messageCall[1] as (msg: TelegramBot.Message) => Promise<void>,
  };
}

describe("Telegram Security - Chat ID Validation", () => {
  let provider: ProviderWithCallbacks;
  let onApproval: ReturnType<typeof vi.fn>;
  let onQuestionResponse: ReturnType<typeof vi.fn>;
  let handlers: ReturnType<typeof extractHandlers>;

  beforeEach(async () => {
    vi.clearAllMocks();

    provider = createTelegramProvider({
      botToken: "fake-token",
      chatId: AUTHORIZED_CHAT_ID,
      polling: true,
    }) as ProviderWithCallbacks;

    onApproval = vi.fn();
    onQuestionResponse = vi.fn();
    provider.onApproval = onApproval;
    provider.onQuestionResponse = onQuestionResponse;

    await provider.connect();
    handlers = extractHandlers(provider);
  });

  afterEach(async () => {
    await provider.disconnect();
  });

  it("rejects callback_query from unauthorized chat", async () => {
    const query = createCallbackQuery({
      chatId: UNAUTHORIZED_CHAT_ID,
      data: "approve:plan-1",
    });

    await handlers.callbackQuery(query);

    expect(onApproval).not.toHaveBeenCalled();
  });

  it("rejects message from unauthorized chat", async () => {
    const userId = 42;

    const awaitingMap = (
      provider as unknown as {
        awaitingRejectionReason: Map<number, string>;
      }
    ).awaitingRejectionReason;
    awaitingMap.set(userId, "plan-1");

    const msg = createMessage({
      chatId: UNAUTHORIZED_CHAT_ID,
      fromId: userId,
      text: "My rejection reason",
    });

    await handlers.message(msg);

    expect(onApproval).not.toHaveBeenCalled();
  });

  it("accepts callback_query from authorized chat", async () => {
    const query = createCallbackQuery({
      chatId: Number(AUTHORIZED_CHAT_ID),
      data: "approve:plan-1",
    });

    await handlers.callbackQuery(query);

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-1",
        approved: true,
      })
    );
  });

  it("accepts message from authorized chat", async () => {
    const userId = 42;

    const awaitingMap = (
      provider as unknown as {
        awaitingRejectionReason: Map<number, string>;
      }
    ).awaitingRejectionReason;
    awaitingMap.set(userId, "plan-1");

    const msg = createMessage({
      chatId: Number(AUTHORIZED_CHAT_ID),
      fromId: userId,
      text: "Not the right approach",
    });

    await handlers.message(msg);

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-1",
        approved: false,
        rejectionReason: "Not the right approach",
      })
    );
  });

  it("logs warning for unauthorized callback_query access attempt", async () => {
    const { logger } = await import("../../utils/logger.js");

    const query = createCallbackQuery({
      chatId: UNAUTHORIZED_CHAT_ID,
      data: "approve:plan-1",
    });

    await handlers.callbackQuery(query);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unauthorized"),
      expect.objectContaining({
        chatId: UNAUTHORIZED_CHAT_ID,
      })
    );
  });
});
