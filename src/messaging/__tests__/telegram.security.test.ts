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

import { TelegramApiClient, createTelegramProvider } from "../telegram.js";

function getInternals(provider: MessagingProvider) {
  return provider as unknown as {
    trackedMessages: Map<number, unknown>;
    pollTimer: ReturnType<typeof setTimeout> | null;
  };
}

const AUTHORIZED_CHAT_ID = "12345";
const UNAUTHORIZED_CHAT_ID = 99999;

describe("Telegram Security - Chat ID Validation", () => {
  let provider: MessagingProvider;
  let onApproval: ReturnType<typeof vi.fn>;
  let messageIdCounter: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    messageIdCounter = 100;

    vi.spyOn(TelegramApiClient.prototype, "getMe").mockResolvedValue({
      id: 123,
      first_name: "TestBot",
    });
    vi.spyOn(TelegramApiClient.prototype, "sendMessage").mockImplementation(
      async () => ({ message_id: messageIdCounter++ })
    );
    vi.spyOn(TelegramApiClient.prototype, "getUpdates").mockResolvedValue([]);

    provider = createTelegramProvider({
      botToken: "fake-token",
      chatId: AUTHORIZED_CHAT_ID,
    });

    onApproval = vi.fn<(response: ApprovalResponse) => void>();
    provider.onApproval = onApproval;

    await provider.connect();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects reply from unauthorized chat ID", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-unauth-1",
      ticketId: "TICK-SEC-1",
      ticketTitle: "Unauthorized reject test",
      plan: "Plan content",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) =>
        (v as { type: string; planId: string }).type === "plan" &&
        (v as { type: string; planId: string }).planId === "plan-unauth-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype
      .getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 5001,
        message: {
          message_id: 9001,
          chat: { id: UNAUTHORIZED_CHAT_ID },
          text: "yes",
          from: { id: 666, first_name: "Intruder" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(onApproval).not.toHaveBeenCalled();
    expect(internals.trackedMessages.has(trackedMessageId)).toBe(true);
  });

  it("accepts reply from authorized chat ID", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-auth-1",
      ticketId: "TICK-SEC-2",
      ticketTitle: "Authorized accept test",
      plan: "Plan content",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) =>
        (v as { type: string; planId: string }).type === "plan" &&
        (v as { type: string; planId: string }).planId === "plan-auth-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype
      .getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 5002,
        message: {
          message_id: 9002,
          chat: { id: Number(AUTHORIZED_CHAT_ID) },
          text: "yes",
          from: { id: 42, first_name: "Owner" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-auth-1",
        approved: true,
      })
    );
  });

  it("logs warning for unauthorized chat access attempt", async () => {
    const { logger } = await import("../../utils/logger.js");

    await provider.sendPlanForApproval({
      planId: "plan-warn-1",
      ticketId: "TICK-SEC-3",
      ticketTitle: "Warning log test",
      plan: "Plan content",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) =>
        (v as { type: string; planId: string }).type === "plan" &&
        (v as { type: string; planId: string }).planId === "plan-warn-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype
      .getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 5003,
        message: {
          message_id: 9003,
          chat: { id: UNAUTHORIZED_CHAT_ID },
          text: "yes",
          from: { id: 666, first_name: "Intruder" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unauthorized"),
      expect.objectContaining({
        chatId: UNAUTHORIZED_CHAT_ID,
      })
    );
  });
});

describe("Telegram Security - Malicious Reply Content", () => {
  let provider: MessagingProvider;
  let onApproval: ReturnType<typeof vi.fn>;
  let messageIdCounter: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    messageIdCounter = 200;

    vi.spyOn(TelegramApiClient.prototype, "getMe").mockResolvedValue({
      id: 123,
      first_name: "TestBot",
    });
    vi.spyOn(TelegramApiClient.prototype, "sendMessage").mockImplementation(
      async () => ({ message_id: messageIdCounter++ })
    );
    vi.spyOn(TelegramApiClient.prototype, "getUpdates").mockResolvedValue([]);

    provider = createTelegramProvider({
      botToken: "fake-token",
      chatId: AUTHORIZED_CHAT_ID,
    });

    onApproval = vi.fn<(response: ApprovalResponse) => void>();
    provider.onApproval = onApproval;

    await provider.connect();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("handles extremely long reply text without crashing", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-long-1",
      ticketId: "TICK-MAL-1",
      ticketTitle: "Long text test",
      plan: "Plan content",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) =>
        (v as { type: string; planId: string }).type === "plan" &&
        (v as { type: string; planId: string }).planId === "plan-long-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const longText = "A".repeat(100_000);

    const getUpdatesSpy = TelegramApiClient.prototype
      .getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 6001,
        message: {
          message_id: 9010,
          chat: { id: Number(AUTHORIZED_CHAT_ID) },
          text: longText,
          from: { id: 42, first_name: "Owner" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-long-1",
        approved: false,
      })
    );

    const callArg = onApproval.mock.calls[0][0] as ApprovalResponse;
    expect(callArg.rejectionReason).toBe(longText);
  });

  it("handles special characters in reply text", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-xss-1",
      ticketId: "TICK-MAL-2",
      ticketTitle: "XSS injection test",
      plan: "Plan content",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) =>
        (v as { type: string; planId: string }).type === "plan" &&
        (v as { type: string; planId: string }).planId === "plan-xss-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const xssText = "<script>alert('xss')</script>";

    const getUpdatesSpy = TelegramApiClient.prototype
      .getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 6002,
        message: {
          message_id: 9011,
          chat: { id: Number(AUTHORIZED_CHAT_ID) },
          text: xssText,
          from: { id: 42, first_name: "Owner" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-xss-1",
        approved: false,
        rejectionReason: xssText,
      })
    );
  });

  it("handles empty text reply", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-empty-1",
      ticketId: "TICK-MAL-3",
      ticketTitle: "Empty text test",
      plan: "Plan content",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) =>
        (v as { type: string; planId: string }).type === "plan" &&
        (v as { type: string; planId: string }).planId === "plan-empty-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype
      .getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 6003,
        message: {
          message_id: 9012,
          chat: { id: Number(AUTHORIZED_CHAT_ID) },
          text: "",
          from: { id: 42, first_name: "Owner" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(onApproval).not.toHaveBeenCalled();
    expect(internals.trackedMessages.has(trackedMessageId)).toBe(true);
  });

  it("ignores non-text replies (no text field)", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-photo-1",
      ticketId: "TICK-MAL-4",
      ticketTitle: "Photo message test",
      plan: "Plan content",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) =>
        (v as { type: string; planId: string }).type === "plan" &&
        (v as { type: string; planId: string }).planId === "plan-photo-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype
      .getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 6004,
        message: {
          message_id: 9013,
          chat: { id: Number(AUTHORIZED_CHAT_ID) },
          from: { id: 42, first_name: "Owner" },
          reply_to_message: { message_id: trackedMessageId },
          photo: [{ file_id: "photo-123", width: 100, height: 100 }],
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(onApproval).not.toHaveBeenCalled();
    expect(internals.trackedMessages.has(trackedMessageId)).toBe(true);
  });
});
