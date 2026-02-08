import { logger } from "../utils/logger.js";
import type {
  MessagingProvider,
  PlanMessage,
  QuestionMessage,
  StatusMessage,
  ApprovalResponse,
  QuestionResponse,
} from "./types.js";

// ─── API Client & Pure Functions ─────────────────────────────────────────────

export class TelegramApiClient {
  private readonly baseUrl: string;

  constructor(botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async getMe(): Promise<{ id: number; first_name: string; username?: string }> {
    const response = await fetch(`${this.baseUrl}/getMe`, { method: "GET" });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.description ?? "getMe failed");
    }
    return data.result;
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: { parse_mode?: string; reply_markup?: unknown }
  ): Promise<{ message_id: number }> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options?.parse_mode) body.parse_mode = options.parse_mode;
    if (options?.reply_markup) body.reply_markup = options.reply_markup;

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.description ?? "sendMessage failed");
    }
    return data.result;
  }

  async getUpdates(offset?: number, timeout?: number): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (offset !== undefined) params.set("offset", String(offset));
    if (timeout !== undefined) params.set("timeout", String(timeout));

    const qs = params.toString();
    const url = `${this.baseUrl}/getUpdates${qs ? `?${qs}` : ""}`;

    const response = await fetch(url, { method: "GET" });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.description ?? "getUpdates failed");
    }
    return data.result;
  }
}

const APPROVAL_WORDS = new Set([
  "y", "yes", "approve", "approved", "ok", "lgtm", "thumbsup", "\u{1F44D}",
]);

export function parseApprovalReply(text: string): { approved: true } | { approved: false; reason: string } {
  const trimmed = text.trim();
  if (APPROVAL_WORDS.has(trimmed.toLowerCase())) {
    return { approved: true };
  }
  return { approved: false, reason: trimmed };
}

export function parseQuestionReply(
  text: string,
  options?: Array<{ label: string; value: string }>
): { answer: string; matchedOption: boolean } {
  const trimmed = text.trim();

  if (options && options.length > 0) {
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= options.length) {
      return { answer: options[num - 1].value, matchedOption: true };
    }

    const match = options.find(
      (o) => o.label.toLowerCase() === trimmed.toLowerCase()
    );
    if (match) {
      return { answer: match.value, matchedOption: true };
    }
  }

  return { answer: trimmed, matchedOption: false };
}

// ─── Provider Configuration ──────────────────────────────────────────────────

export interface TelegramProviderConfig {
  botToken: string;
  chatId: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TELEGRAM_MESSAGE_LIMIT = 4096;

const STATUS_EMOJIS: Record<StatusMessage["status"], string> = {
  started: "\u{1F680}",
  completed: "\u2705",
  failed: "\u274C",
  skipped: "\u23ED\uFE0F",
};

const BASE_BACKOFF = 3000;
const MAX_BACKOFF = 60000;
const BACKOFF_MULTIPLIER = 1.3;

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[]/g, "\\$&");
}

// ─── Tracked Message Types ───────────────────────────────────────────────────

type TrackedMessage =
  | { type: "plan"; planId: string }
  | { type: "question"; questionId: string; options?: Array<{ label: string; value: string }> };

// ─── Telegram Provider ──────────────────────────────────────────────────────

class TelegramProvider implements MessagingProvider {
  readonly name = "telegram";

  api: TelegramApiClient;
  private connected = false;
  private readonly chatId: string;

  trackedMessages: Map<number, TrackedMessage> = new Map();
  pollTimer: ReturnType<typeof setTimeout> | null = null;
  currentBackoff: number = BASE_BACKOFF;
  updateOffset: number = 0;

  onApproval?: (response: ApprovalResponse) => void;
  onQuestionResponse?: (response: QuestionResponse) => void;

  constructor(config: TelegramProviderConfig) {
    this.api = new TelegramApiClient(config.botToken);
    this.chatId = config.chatId;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      logger.debug("Telegram provider already connected");
      return;
    }

    // Validate token
    await this.api.getMe();

    // Flush stale updates
    try {
      const stale = await this.api.getUpdates(-1);
      if (stale.length > 0) {
        const lastUpdate = stale[stale.length - 1] as { update_id: number };
        this.updateOffset = lastUpdate.update_id + 1;
        logger.info("Flushed stale Telegram updates", {
          count: stale.length,
          nextOffset: this.updateOffset,
        });
      }
    } catch (error) {
      logger.warn("Failed to flush stale updates", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.connected = true;
    logger.info("Telegram provider connected", { chatId: this.chatId });
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.trackedMessages.clear();
    this.currentBackoff = BASE_BACKOFF;
    this.updateOffset = 0;
    this.connected = false;

    logger.debug("Telegram provider disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendPlanForApproval(plan: PlanMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("Telegram provider not connected");
    }

    logger.info("Sending plan to Telegram", {
      planId: plan.planId,
      ticketId: plan.ticketId,
      planLength: plan.plan.length,
    });

    // Send header
    const header = [
      "\u{1F4CB} *Plan Review*",
      `*Ticket:* ${escapeMarkdown(plan.ticketId)} \\- ${escapeMarkdown(plan.ticketTitle)}`,
    ].join("\n");

    try {
      await this.api.sendMessage(this.chatId, header, { parse_mode: "Markdown" });
    } catch {
      await this.api.sendMessage(
        this.chatId,
        `\u{1F4CB} Plan Review\nTicket: ${plan.ticketId} - ${plan.ticketTitle}`
      );
    }

    // Send plan content chunks
    const chunks = splitMessage(plan.plan, TELEGRAM_MESSAGE_LIMIT - 100);
    for (const chunk of chunks) {
      try {
        await this.api.sendMessage(this.chatId, chunk);
      } catch (error) {
        logger.warn("Failed to send plan chunk", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Send approval prompt — this is the message we track
    const prompt = `[${plan.ticketId}] Reply to this message to approve or reject.\n\nReply "yes" to approve, or reply with feedback to reject.`;
    const sentPrompt = await this.api.sendMessage(this.chatId, prompt);

    this.trackedMessages.set(sentPrompt.message_id, {
      type: "plan",
      planId: plan.planId,
    });

    logger.info("Plan sent with reply-based approval", {
      planId: plan.planId,
      promptMessageId: sentPrompt.message_id,
    });

    this.ensurePolling();
  }

  async sendQuestion(question: QuestionMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("Telegram provider not connected");
    }

    let text: string;
    if (question.options && question.options.length > 0) {
      const optionLines = question.options
        .map((o, i) => `${i + 1}. ${o.label}`)
        .join("\n");
      text = `\u2753 *Question*\n*Ticket:* ${escapeMarkdown(question.ticketId)} \\- ${escapeMarkdown(question.ticketTitle)}\n\n${escapeMarkdown(question.question)}\n\n${optionLines}\n\nReply with the option number or your answer.`;
    } else {
      text = `\u2753 *Question*\n*Ticket:* ${escapeMarkdown(question.ticketId)} \\- ${escapeMarkdown(question.ticketTitle)}\n\n${escapeMarkdown(question.question)}\n\nReply to this message with your answer.`;
    }

    const sent = await this.api.sendMessage(this.chatId, text, { parse_mode: "Markdown" });

    this.trackedMessages.set(sent.message_id, {
      type: "question",
      questionId: question.questionId,
      options: question.options,
    });

    logger.info("Question sent", {
      questionId: question.questionId,
      messageId: sent.message_id,
      hasOptions: !!(question.options && question.options.length > 0),
    });

    this.ensurePolling();
  }

  async sendStatus(status: StatusMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("Telegram provider not connected");
    }

    const emoji = STATUS_EMOJIS[status.status];
    const statusLabel = status.status.toUpperCase();

    let message = `${emoji} *${statusLabel}*\n`;
    message += `*Ticket:* ${escapeMarkdown(status.ticketId)} \\- ${escapeMarkdown(status.ticketTitle)}`;

    if (status.message) {
      message += `\n${escapeMarkdown(status.message)}`;
    }

    if (status.status === "failed" && status.error) {
      message += `\n\n\u26A0\uFE0F *Error:* ${escapeMarkdown(status.error)}`;
    }

    try {
      await this.api.sendMessage(this.chatId, message, { parse_mode: "Markdown" });
    } catch {
      // Fallback to plain text
      await this.api.sendMessage(this.chatId, `${emoji} ${statusLabel}\nTicket: ${status.ticketId} - ${status.ticketTitle}${status.message ? "\n" + status.message : ""}`);
    }

    logger.info("Sent status to Telegram", {
      ticketId: status.ticketId,
      status: status.status,
    });
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  private ensurePolling(): void {
    if (this.pollTimer !== null) return;
    this.currentBackoff = BASE_BACKOFF;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.trackedMessages.size === 0) {
      this.pollTimer = null;
      return;
    }

    this.pollTimer = setTimeout(() => {
      this.pollForReplies().catch((error) => {
        logger.error("Unhandled polling error", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Still try to schedule next poll
        this.schedulePoll();
      });
    }, this.currentBackoff);
  }

  private async pollForReplies(): Promise<void> {
    if (!this.connected || this.trackedMessages.size === 0) {
      this.pollTimer = null;
      return;
    }

    logger.debug("Polling for replies", {
      offset: this.updateOffset,
      trackedCount: this.trackedMessages.size,
      trackedIds: [...this.trackedMessages.keys()],
      backoff: this.currentBackoff,
    });

    let hadResponse = false;

    try {
      const updates = await this.api.getUpdates(
        this.updateOffset > 0 ? this.updateOffset : undefined
      );

      logger.debug("getUpdates response", {
        updateCount: updates.length,
        updateIds: updates.map((u: unknown) => (u as { update_id: number }).update_id),
      });

      for (const raw of updates) {
        const update = raw as {
          update_id: number;
          message?: {
            message_id: number;
            chat: { id: number };
            text?: string;
            from?: { id: number; first_name?: string; username?: string };
            reply_to_message?: { message_id: number };
          };
          channel_post?: {
            message_id: number;
            chat: { id: number };
            text?: string;
            sender_chat?: { id: number; title?: string };
            reply_to_message?: { message_id: number };
          };
        };

        // Advance offset past this update
        this.updateOffset = update.update_id + 1;

        const msg = update.message ?? update.channel_post;

        logger.debug("Processing update", {
          updateId: update.update_id,
          hasMessage: !!update.message,
          hasChannelPost: !!update.channel_post,
          chatId: msg?.chat?.id,
          text: msg?.text?.slice(0, 100),
          replyToMessageId: msg?.reply_to_message?.message_id,
          isTracked: msg?.reply_to_message
            ? this.trackedMessages.has(msg.reply_to_message.message_id)
            : false,
        });

        if (!msg || !msg.text || !msg.reply_to_message) continue;

        // Chat ID validation
        if (String(msg.chat.id) !== this.chatId) {
          logger.warn("Rejected update from unauthorized chat", {
            chatId: msg.chat.id,
            expectedChatId: this.chatId,
          });
          continue;
        }

        const replyToId = msg.reply_to_message.message_id;
        const tracked = this.trackedMessages.get(replyToId);
        if (!tracked) {
          logger.debug("Reply to untracked message, skipping", {
            replyToId,
            trackedIds: [...this.trackedMessages.keys()],
          });
          continue;
        }

        const respondedBy =
          (msg as { from?: { username?: string; first_name?: string; id?: number } }).from?.username
          || (msg as { from?: { username?: string; first_name?: string; id?: number } }).from?.first_name
          || (msg as { sender_chat?: { title?: string; id?: number } }).sender_chat?.title
          || String((msg as { from?: { id?: number } }).from?.id ?? "unknown");

        if (tracked.type === "plan") {
          const result = parseApprovalReply(msg.text);
          if (this.onApproval) {
            this.onApproval({
              planId: tracked.planId,
              approved: result.approved,
              rejectionReason: result.approved ? undefined : (result as { reason: string }).reason || undefined,
              respondedBy,
              respondedAt: new Date(),
            });
          }
          this.trackedMessages.delete(replyToId);
          hadResponse = true;

          logger.info("Plan approval received via reply", {
            planId: tracked.planId,
            approved: result.approved,
            respondedBy,
          });
        } else if (tracked.type === "question") {
          const result = parseQuestionReply(msg.text, tracked.options);
          if (this.onQuestionResponse) {
            this.onQuestionResponse({
              questionId: tracked.questionId,
              answer: result.answer,
              respondedBy,
              respondedAt: new Date(),
            });
          }
          this.trackedMessages.delete(replyToId);
          hadResponse = true;

          logger.info("Question answer received via reply", {
            questionId: tracked.questionId,
            answer: result.answer,
            respondedBy,
          });
        }
      }
    } catch (error) {
      logger.warn("Polling error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Adjust backoff
    if (hadResponse) {
      this.currentBackoff = BASE_BACKOFF;
    } else {
      this.currentBackoff = Math.min(
        this.currentBackoff * BACKOFF_MULTIPLIER,
        MAX_BACKOFF
      );
    }

    logger.debug("Poll cycle complete", {
      hadResponse,
      newBackoff: this.currentBackoff,
      remainingTracked: this.trackedMessages.size,
    });

    // Schedule next poll if there are still tracked messages
    this.schedulePoll();
  }
}

// ─── Utility: Split Message ──────────────────────────────────────────────────

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex <= 0 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex <= 0 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }

  return chunks;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTelegramProvider(
  config: TelegramProviderConfig
): MessagingProvider {
  return new TelegramProvider(config);
}
