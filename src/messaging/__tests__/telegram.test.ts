import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  MessagingProvider,
  ApprovalResponse,
  QuestionResponse,
} from "../types.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setContext: vi.fn(),
  },
}));

import {
  TelegramApiClient,
  parseApprovalReply,
  parseQuestionReply,
  createTelegramProvider,
} from "../telegram.js";

function createFetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

// =============================================================================
// TelegramApiClient
// =============================================================================

describe("TelegramApiClient", () => {
  const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

  let client: TelegramApiClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new TelegramApiClient(BOT_TOKEN);
  });

  // ---------------------------------------------------------------------------
  // getMe
  // ---------------------------------------------------------------------------

  it("getMe calls correct URL with GET and returns parsed result", async () => {
    const mockResponse = {
      ok: true,
      result: { id: 123456, first_name: "TestBot", username: "test_bot" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createFetchResponse(mockResponse)
    );

    const result = await client.getMe();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/getMe`,
      expect.objectContaining({ method: "GET" })
    );
    expect(result).toEqual({
      id: 123456,
      first_name: "TestBot",
      username: "test_bot",
    });
  });

  it("getMe throws on non-ok response with Telegram error description", async () => {
    const errorResponse = {
      ok: false,
      description: "Unauthorized",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createFetchResponse(errorResponse, false, 401)
    );

    await expect(client.getMe()).rejects.toThrow("Unauthorized");
  });

  // ---------------------------------------------------------------------------
  // sendMessage
  // ---------------------------------------------------------------------------

  it("sendMessage calls correct URL with POST and correct JSON body", async () => {
    const mockResponse = {
      ok: true,
      result: { message_id: 42 },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createFetchResponse(mockResponse)
    );

    const result = await client.sendMessage("12345", "Hello, world!");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/sendMessage`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          chat_id: "12345",
          text: "Hello, world!",
        }),
      })
    );
    expect(result).toEqual({ message_id: 42 });
  });

  it("sendMessage includes parse_mode and reply_markup when provided", async () => {
    const mockResponse = {
      ok: true,
      result: { message_id: 99 },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createFetchResponse(mockResponse)
    );

    const replyMarkup = {
      inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
    };

    await client.sendMessage("12345", "Pick one", {
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/sendMessage`,
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "12345",
          text: "Pick one",
          parse_mode: "Markdown",
          reply_markup: replyMarkup,
        }),
      })
    );
  });

  // ---------------------------------------------------------------------------
  // getUpdates
  // ---------------------------------------------------------------------------

  it("getUpdates calls correct URL with offset and timeout query params", async () => {
    const mockResponse = {
      ok: true,
      result: [{ update_id: 1 }, { update_id: 2 }],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createFetchResponse(mockResponse)
    );

    const result = await client.getUpdates(100, 30);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/getUpdates?offset=100&timeout=30`,
      expect.objectContaining({ method: "GET" })
    );
    expect(result).toEqual([{ update_id: 1 }, { update_id: 2 }]);
  });

  it("getUpdates with no params calls URL without query params", async () => {
    const mockResponse = {
      ok: true,
      result: [],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createFetchResponse(mockResponse)
    );

    await client.getUpdates();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/getUpdates`,
      expect.objectContaining({ method: "GET" })
    );
  });

  it("getUpdates returns array of update objects", async () => {
    const updates = [
      {
        update_id: 10,
        message: {
          message_id: 1,
          chat: { id: 12345 },
          text: "hello",
        },
      },
      {
        update_id: 11,
        message: {
          message_id: 2,
          chat: { id: 12345 },
          text: "world",
        },
      },
    ];
    const mockResponse = { ok: true, result: updates };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createFetchResponse(mockResponse)
    );

    const result = await client.getUpdates(10);

    expect(result).toEqual(updates);
    expect(result).toHaveLength(2);
  });
});

// =============================================================================
// parseApprovalReply
// =============================================================================

describe("parseApprovalReply", () => {
  it.each([
    ["yes"],
    ["y"],
    ["approve"],
    ["approved"],
    ["ok"],
    ["lgtm"],
  ])('"%s" returns approved', (input) => {
    expect(parseApprovalReply(input)).toEqual({ approved: true });
  });

  it('"LGTM" returns approved (case-insensitive)', () => {
    expect(parseApprovalReply("LGTM")).toEqual({ approved: true });
  });

  it('" yes " returns approved (trimmed)', () => {
    expect(parseApprovalReply(" yes ")).toEqual({ approved: true });
  });

  it('"thumbsup" returns approved', () => {
    expect(parseApprovalReply("thumbsup")).toEqual({ approved: true });
  });

  it('emoji thumbs up returns approved', () => {
    expect(parseApprovalReply("\u{1F44D}")).toEqual({ approved: true });
  });

  it('"no" returns rejected with reason "no"', () => {
    expect(parseApprovalReply("no")).toEqual({
      approved: false,
      reason: "no",
    });
  });

  it('"I don\'t like this approach" returns rejected with the text as reason', () => {
    const text = "I don't like this approach";
    expect(parseApprovalReply(text)).toEqual({
      approved: false,
      reason: text,
    });
  });

  it('empty string returns rejected with empty reason', () => {
    expect(parseApprovalReply("")).toEqual({
      approved: false,
      reason: "",
    });
  });

  it('whitespace-only string returns rejected with empty reason', () => {
    expect(parseApprovalReply("   ")).toEqual({
      approved: false,
      reason: "",
    });
  });
});

// =============================================================================
// parseQuestionReply
// =============================================================================

describe("parseQuestionReply", () => {
  const threeOptions = [
    { label: "Option A", value: "a" },
    { label: "Option B", value: "b" },
    { label: "Option C", value: "c" },
  ];

  it('"1" with 3 options returns first option value with matchedOption true', () => {
    expect(parseQuestionReply("1", threeOptions)).toEqual({
      answer: "a",
      matchedOption: true,
    });
  });

  it('"3" with 3 options returns third option value with matchedOption true', () => {
    expect(parseQuestionReply("3", threeOptions)).toEqual({
      answer: "c",
      matchedOption: true,
    });
  });

  it('"0" with 3 options returns "0" as answer with matchedOption false (out of range)', () => {
    expect(parseQuestionReply("0", threeOptions)).toEqual({
      answer: "0",
      matchedOption: false,
    });
  });

  it('"4" with 3 options returns "4" as answer with matchedOption false (out of range)', () => {
    expect(parseQuestionReply("4", threeOptions)).toEqual({
      answer: "4",
      matchedOption: false,
    });
  });

  it('"Option A" matching label case-insensitive returns matching option value', () => {
    expect(parseQuestionReply("option a", threeOptions)).toEqual({
      answer: "a",
      matchedOption: true,
    });
  });

  it('"free text answer" with no options returns trimmed text with matchedOption false', () => {
    expect(parseQuestionReply("free text answer")).toEqual({
      answer: "free text answer",
      matchedOption: false,
    });
  });

  it('"free text" with options but no match returns trimmed text with matchedOption false', () => {
    expect(parseQuestionReply("free text", threeOptions)).toEqual({
      answer: "free text",
      matchedOption: false,
    });
  });
});

// =============================================================================
// TelegramProvider — New provider tests (reply-to-message correlation, polling)
//
// These tests target the NEW TelegramProvider that uses TelegramApiClient
// internally (replacing the node-telegram-bot-api wrapper). The provider is
// created via createTelegramProvider() and we spy on TelegramApiClient.prototype
// methods to control API responses without network calls.
// =============================================================================

// -- Helpers for provider tests -----------------------------------------------

type TrackedMessage =
  | { type: "plan"; planId: string }
  | { type: "question"; questionId: string; options?: Array<{ label: string; value: string }> };

interface ProviderInternals {
  api: TelegramApiClient;
  trackedMessages: Map<number, TrackedMessage>;
  pollTimer: ReturnType<typeof setTimeout> | null;
  currentBackoff: number;
  updateOffset: number;
}

function getInternals(provider: MessagingProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

// =============================================================================
// TelegramProvider - Lifecycle
// =============================================================================

describe("TelegramProvider - Lifecycle", () => {
  let provider: MessagingProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(TelegramApiClient.prototype, "getMe").mockResolvedValue({
      id: 123,
      first_name: "TestBot",
    });
    vi.spyOn(TelegramApiClient.prototype, "sendMessage").mockResolvedValue({
      message_id: 1,
    });
    vi.spyOn(TelegramApiClient.prototype, "getUpdates").mockResolvedValue([]);

    provider = createTelegramProvider({ botToken: "fake-token", chatId: "12345" });
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connect() validates token by calling getMe", async () => {
    await provider.connect();

    expect(TelegramApiClient.prototype.getMe).toHaveBeenCalled();
  });

  it("connect() flushes stale updates by calling getUpdates with offset -1", async () => {
    await provider.connect();

    expect(TelegramApiClient.prototype.getUpdates).toHaveBeenCalledWith(-1);
  });

  it("connect() sets isConnected to true", async () => {
    expect(provider.isConnected()).toBe(false);

    await provider.connect();

    expect(provider.isConnected()).toBe(true);
  });

  it("connect() throws if getMe fails", async () => {
    vi.mocked(TelegramApiClient.prototype.getMe).mockRejectedValueOnce(
      new Error("Unauthorized")
    );

    await expect(provider.connect()).rejects.toThrow("Unauthorized");
    expect(provider.isConnected()).toBe(false);
  });

  it("disconnect() clears state and sets isConnected to false", async () => {
    await provider.connect();
    expect(provider.isConnected()).toBe(true);

    await provider.disconnect();

    expect(provider.isConnected()).toBe(false);
    const internals = getInternals(provider);
    expect(internals.trackedMessages.size).toBe(0);
    expect(internals.pollTimer).toBeNull();
  });
});

// =============================================================================
// TelegramProvider - sendPlanForApproval
// =============================================================================

describe("TelegramProvider - sendPlanForApproval", () => {
  let provider: MessagingProvider;
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

    provider = createTelegramProvider({ botToken: "fake-token", chatId: "12345" });
    await provider.connect();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends header, plan chunks, and approval prompt", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-1",
      ticketId: "TICK-1",
      ticketTitle: "Fix login bug",
      plan: "Step 1: Investigate\nStep 2: Fix\nStep 3: Test",
    });

    const sendMessageSpy = TelegramApiClient.prototype.sendMessage as ReturnType<typeof vi.fn>;
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    const lastCallText = sendMessageSpy.mock.calls[sendMessageSpy.mock.calls.length - 1][1] as string;
    expect(
      lastCallText.toLowerCase().includes("reply") ||
      lastCallText.toLowerCase().includes("approve")
    ).toBe(true);
  });

  it("tracks the prompt message ID for reply matching", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-42",
      ticketId: "TICK-2",
      ticketTitle: "Add feature",
      plan: "Implementation plan here",
    });

    const internals = getInternals(provider);
    const tracked = [...internals.trackedMessages.entries()];
    const planEntry = tracked.find(
      ([, v]) => v.type === "plan" && v.planId === "plan-42"
    );

    expect(planEntry).toBeDefined();
  });

  it("starts polling after sending", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-3",
      ticketId: "TICK-3",
      ticketTitle: "Polling test",
      plan: "Plan content",
    });

    const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
    const callsBefore = getUpdatesSpy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(3500);

    expect(getUpdatesSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// =============================================================================
// TelegramProvider - sendQuestion
// =============================================================================

describe("TelegramProvider - sendQuestion", () => {
  let provider: MessagingProvider;
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

    provider = createTelegramProvider({ botToken: "fake-token", chatId: "12345" });
    await provider.connect();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends question with numbered options", async () => {
    await provider.sendQuestion({
      questionId: "q-1",
      ticketId: "TICK-10",
      ticketTitle: "Choose approach",
      question: "Which framework?",
      options: [
        { label: "React", value: "react" },
        { label: "Vue", value: "vue" },
      ],
    });

    const sendMessageSpy = TelegramApiClient.prototype.sendMessage as ReturnType<typeof vi.fn>;
    const sentTexts = sendMessageSpy.mock.calls.map(
      (call: unknown[]) => call[1] as string
    );
    const hasNumberedOptions = sentTexts.some(
      (text: string) => text.includes("1.") || text.includes("1)")
    );
    expect(hasNumberedOptions).toBe(true);
  });

  it("sends free-text question prompt", async () => {
    await provider.sendQuestion({
      questionId: "q-2",
      ticketId: "TICK-11",
      ticketTitle: "Open question",
      question: "What is your preferred database?",
    });

    const sendMessageSpy = TelegramApiClient.prototype.sendMessage as ReturnType<typeof vi.fn>;
    const sentTexts = sendMessageSpy.mock.calls.map(
      (call: unknown[]) => call[1] as string
    );
    const hasQuestion = sentTexts.some((text: string) =>
      text.includes("preferred database")
    );
    expect(hasQuestion).toBe(true);
  });

  it("tracks message ID for reply matching", async () => {
    await provider.sendQuestion({
      questionId: "q-3",
      ticketId: "TICK-12",
      ticketTitle: "Track test",
      question: "Pick a color",
      options: [{ label: "Red", value: "red" }],
    });

    const internals = getInternals(provider);
    const tracked = [...internals.trackedMessages.entries()];
    const questionEntry = tracked.find(
      ([, v]) => v.type === "question" && v.questionId === "q-3"
    );

    expect(questionEntry).toBeDefined();
  });
});

// =============================================================================
// TelegramProvider - sendStatus
// =============================================================================

describe("TelegramProvider - sendStatus", () => {
  let provider: MessagingProvider;

  beforeEach(async () => {
    vi.useFakeTimers();

    vi.spyOn(TelegramApiClient.prototype, "getMe").mockResolvedValue({
      id: 123,
      first_name: "TestBot",
    });
    vi.spyOn(TelegramApiClient.prototype, "sendMessage").mockResolvedValue({
      message_id: 300,
    });
    vi.spyOn(TelegramApiClient.prototype, "getUpdates").mockResolvedValue([]);

    provider = createTelegramProvider({ botToken: "fake-token", chatId: "12345" });
    await provider.connect();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends formatted status message", async () => {
    await provider.sendStatus({
      ticketId: "TICK-20",
      ticketTitle: "Deploy service",
      status: "completed",
      message: "All checks passed",
    });

    const sendMessageSpy = TelegramApiClient.prototype.sendMessage as ReturnType<typeof vi.fn>;
    const lastCallText = sendMessageSpy.mock.calls[sendMessageSpy.mock.calls.length - 1][1] as string;

    expect(lastCallText).toContain("TICK-20");
  });

  it("does not track message for replies", async () => {
    await provider.sendStatus({
      ticketId: "TICK-21",
      ticketTitle: "Status only",
      status: "started",
    });

    const internals = getInternals(provider);
    expect(internals.trackedMessages.size).toBe(0);
  });
});

// =============================================================================
// TelegramProvider - Polling Loop
// =============================================================================

describe("TelegramProvider - Polling Loop", () => {
  let provider: MessagingProvider;
  let messageIdCounter: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    messageIdCounter = 400;

    vi.spyOn(TelegramApiClient.prototype, "getMe").mockResolvedValue({
      id: 123,
      first_name: "TestBot",
    });
    vi.spyOn(TelegramApiClient.prototype, "sendMessage").mockImplementation(
      async () => ({ message_id: messageIdCounter++ })
    );
    vi.spyOn(TelegramApiClient.prototype, "getUpdates").mockResolvedValue([]);

    provider = createTelegramProvider({ botToken: "fake-token", chatId: "12345" });
    await provider.connect();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("matches reply_to_message to tracked plan and calls onApproval", async () => {
    const approvalCallback = vi.fn<(response: ApprovalResponse) => void>();
    provider.onApproval = approvalCallback;

    await provider.sendPlanForApproval({
      planId: "plan-poll-1",
      ticketId: "TICK-30",
      ticketTitle: "Poll approval test",
      plan: "Plan content here",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) => v.type === "plan" && v.planId === "plan-poll-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 1001,
        message: {
          message_id: 999,
          chat: { id: 12345 },
          text: "yes",
          from: { id: 777, first_name: "Tester" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(approvalCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-poll-1",
        approved: true,
      })
    );
  });

  it("matches reply_to_message to tracked question and calls onQuestionResponse", async () => {
    const questionCallback = vi.fn<(response: QuestionResponse) => void>();
    provider.onQuestionResponse = questionCallback;

    await provider.sendQuestion({
      questionId: "q-poll-1",
      ticketId: "TICK-31",
      ticketTitle: "Poll question test",
      question: "Pick a number",
      options: [
        { label: "One", value: "1" },
        { label: "Two", value: "2" },
      ],
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) => v.type === "question" && v.questionId === "q-poll-1"
    );
    expect(trackedEntry).toBeDefined();
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 1002,
        message: {
          message_id: 1000,
          chat: { id: 12345 },
          text: "1",
          from: { id: 778, first_name: "Answerer" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(questionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: "q-poll-1",
        answer: "1",
      })
    );
  });

  it("removes tracked message after processing", async () => {
    const approvalCallback = vi.fn<(response: ApprovalResponse) => void>();
    provider.onApproval = approvalCallback;

    await provider.sendPlanForApproval({
      planId: "plan-remove-1",
      ticketId: "TICK-32",
      ticketTitle: "Removal test",
      plan: "Plan to remove",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) => v.type === "plan" && v.planId === "plan-remove-1"
    );
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 1003,
        message: {
          message_id: 1001,
          chat: { id: 12345 },
          text: "approve",
          from: { id: 779, first_name: "Approver" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(internals.trackedMessages.has(trackedMessageId)).toBe(false);
  });

  it("stops polling when no tracked messages remain", async () => {
    const approvalCallback = vi.fn<(response: ApprovalResponse) => void>();
    provider.onApproval = approvalCallback;

    await provider.sendPlanForApproval({
      planId: "plan-stop-1",
      ticketId: "TICK-33",
      ticketTitle: "Stop polling test",
      plan: "Plan for stop test",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) => v.type === "plan" && v.planId === "plan-stop-1"
    );
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 1004,
        message: {
          message_id: 1002,
          chat: { id: 12345 },
          text: "yes",
          from: { id: 780, first_name: "Approver" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);
    expect(approvalCallback).toHaveBeenCalled();

    const callsAfterApproval = getUpdatesSpy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(15000);

    expect(getUpdatesSpy.mock.calls.length).toBe(callsAfterApproval);
  });

  it("ignores updates from unauthorized chat ID", async () => {
    const approvalCallback = vi.fn<(response: ApprovalResponse) => void>();
    provider.onApproval = approvalCallback;

    await provider.sendPlanForApproval({
      planId: "plan-auth-1",
      ticketId: "TICK-34",
      ticketTitle: "Auth test",
      plan: "Plan for auth check",
    });

    const internals = getInternals(provider);
    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) => v.type === "plan" && v.planId === "plan-auth-1"
    );
    const [trackedMessageId] = trackedEntry!;

    const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockResolvedValueOnce([
      {
        update_id: 1005,
        message: {
          message_id: 1003,
          chat: { id: 99999 },
          text: "yes",
          from: { id: 781, first_name: "Stranger" },
          reply_to_message: { message_id: trackedMessageId },
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(3500);

    expect(approvalCallback).not.toHaveBeenCalled();
    expect(internals.trackedMessages.has(trackedMessageId)).toBe(true);
  });

  it("handles API errors without crashing", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-err-1",
      ticketId: "TICK-35",
      ticketTitle: "Error resilience test",
      plan: "Plan for error test",
    });

    const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
    getUpdatesSpy.mockRejectedValueOnce(new Error("Network failure"));

    await vi.advanceTimersByTimeAsync(3500);

    const internals = getInternals(provider);
    expect(internals.trackedMessages.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// TelegramProvider - Backoff
// =============================================================================

describe("TelegramProvider - Backoff", () => {
  let provider: MessagingProvider;
  let messageIdCounter: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    messageIdCounter = 500;

    vi.spyOn(TelegramApiClient.prototype, "getMe").mockResolvedValue({
      id: 123,
      first_name: "TestBot",
    });
    vi.spyOn(TelegramApiClient.prototype, "sendMessage").mockImplementation(
      async () => ({ message_id: messageIdCounter++ })
    );
    vi.spyOn(TelegramApiClient.prototype, "getUpdates").mockResolvedValue([]);

    provider = createTelegramProvider({ botToken: "fake-token", chatId: "12345" });
    await provider.connect();
  });

  afterEach(async () => {
    await provider.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("increases backoff on empty poll response", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-backoff-1",
      ticketId: "TICK-40",
      ticketTitle: "Backoff growth test",
      plan: "Plan for backoff",
    });

    const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
    const callsBefore = getUpdatesSpy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(3100);
    const callsAfterFirst = getUpdatesSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(callsBefore);

    await vi.advanceTimersByTimeAsync(3100);
    const callsAfterMaybe = getUpdatesSpy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1500);
    const callsAfterBackoff = getUpdatesSpy.mock.calls.length;

    expect(callsAfterBackoff).toBeGreaterThan(callsAfterFirst);

    const internals = getInternals(provider);
    expect(internals.currentBackoff).toBeGreaterThan(3000);
  });

  it("resets backoff to base after receiving a response", async () => {
    const approvalCallback = vi.fn<(response: ApprovalResponse) => void>();
    provider.onApproval = approvalCallback;

    await provider.sendPlanForApproval({
      planId: "plan-backoff-reset-1",
      ticketId: "TICK-41",
      ticketTitle: "Backoff reset test",
      plan: "Plan for backoff reset",
    });

    await vi.advanceTimersByTimeAsync(3100);
    await vi.advanceTimersByTimeAsync(4600);

    const internals = getInternals(provider);
    expect(internals.currentBackoff).toBeGreaterThan(3000);

    const trackedEntry = [...internals.trackedMessages.entries()].find(
      ([, v]) => v.type === "plan" && v.planId === "plan-backoff-reset-1"
    );

    if (trackedEntry) {
      const [trackedMessageId] = trackedEntry;
      const getUpdatesSpy = TelegramApiClient.prototype.getUpdates as ReturnType<typeof vi.fn>;
      getUpdatesSpy.mockResolvedValueOnce([
        {
          update_id: 2001,
          message: {
            message_id: 2000,
            chat: { id: 12345 },
            text: "yes",
            from: { id: 800, first_name: "Resetter" },
            reply_to_message: { message_id: trackedMessageId },
          },
        },
      ]);

      await vi.advanceTimersByTimeAsync(5000);

      expect(internals.currentBackoff).toBeLessThanOrEqual(3000);
    }
  });

  it("caps backoff at 60 seconds", async () => {
    await provider.sendPlanForApproval({
      planId: "plan-backoff-cap-1",
      ticketId: "TICK-42",
      ticketTitle: "Backoff cap test",
      plan: "Plan for cap test",
    });

    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(61000);
    }

    const internals = getInternals(provider);
    expect(internals.currentBackoff).toBeLessThanOrEqual(60000);
  });
});
