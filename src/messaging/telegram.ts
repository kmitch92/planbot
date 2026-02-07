import TelegramBot from "node-telegram-bot-api";
import { logger } from "../utils/logger.js";
import type {
  MessagingProvider,
  PlanMessage,
  QuestionMessage,
  StatusMessage,
  ApprovalResponse,
  QuestionResponse,
} from "./types.js";

/**
 * Configuration options for the Telegram provider.
 */
export interface TelegramProviderConfig {
  /** Telegram bot token from @BotFather */
  botToken: string;
  /** Chat/group ID to send messages to */
  chatId: string;
  /** Use polling (default true) vs webhook */
  polling?: boolean;
}

/**
 * Telegram message limit in characters.
 */
const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Status emojis for different status types.
 */
const STATUS_EMOJIS: Record<StatusMessage["status"], string> = {
  started: "🚀",
  completed: "✅",
  failed: "❌",
  skipped: "⏭️",
};

/**
 * Escape special characters for Telegram Markdown (v1).
 * Less strict than MarkdownV2, only needs to escape a few chars.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[]/g, "\\$&");
}

/**
 * Truncate text to fit within a maximum length.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Pending rejection state for tracking rejection reason requests.
 */
interface PendingRejection {
  planId: string;
  messageId: number;
}

/**
 * Pending question state for tracking question responses.
 */
interface PendingQuestion {
  questionId: string;
  messageId: number;
  options?: Array<{ label: string; value: string }>;
}

/**
 * Full plan storage for view requests.
 */
interface StoredPlan {
  planId: string;
  ticketId: string;
  ticketTitle: string;
  plan: string;
}

/**
 * Telegram messaging provider using node-telegram-bot-api.
 * Supports plan approvals via inline keyboards and question handling.
 */
class TelegramProvider implements MessagingProvider {
  readonly name = "telegram";

  private bot: TelegramBot | null = null;
  private connected = false;
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly usePolling: boolean;

  /** Interval for periodic health checks */
  private healthCheckInterval: NodeJS.Timeout | null = null;
  /** Consecutive polling error counter */
  private pollingErrorCount = 0;
  /** Maximum consecutive polling errors before restart */
  private readonly maxPollingErrors = 5;

  /** Map of message ID to pending rejection for tracking rejection reasons */
  private pendingRejections: Map<number, PendingRejection> = new Map();
  /** Map of message ID to pending question for tracking question responses */
  private pendingQuestions: Map<number, PendingQuestion> = new Map();
  /** Map of plan ID to approval message ID for inline keyboard editing */
  private pendingApprovalMessages: Map<string, number> = new Map();
  /** Map of question ID to pending question button data for callback handling */
  private pendingQuestionButtons: Map<string, PendingQuestion> = new Map();
  /** Map of plan ID to stored full plan for view requests */
  private storedPlans: Map<string, StoredPlan> = new Map();
  /** Map of user ID to plan ID awaiting rejection reason */
  private awaitingRejectionReason: Map<number, string> = new Map();

  // Callbacks set by multiplexer
  onApproval?: (response: ApprovalResponse) => void;
  onQuestionResponse?: (response: QuestionResponse) => void;

  constructor(config: TelegramProviderConfig) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.usePolling = config.polling ?? true;
  }

  /**
   * Connect to Telegram and register event handlers.
   * Creates the bot with polling disabled, deletes any stale webhook,
   * registers handlers, then starts polling to avoid 409 Conflict race.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      logger.debug("Telegram provider already connected");
      return;
    }

    try {
      // Create bot with polling OFF to avoid the constructor starting
      // polling before the stale webhook is cleared
      this.bot = new TelegramBot(this.botToken, { polling: false });

      // Clear any stale webhook BEFORE polling starts
      if (this.usePolling) {
        await this.bot.deleteWebHook();
        logger.info("Cleared webhook before starting polling");
      }

      // Register ALL event handlers before polling begins
      this.bot.on("message", (msg) => {
        this.handleMessage(msg).catch((error) => {
          logger.error("Error handling message", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      this.bot.on("callback_query", (query) => {
        this.handleCallbackQuery(query).catch((error) => {
          logger.error("Error handling callback query", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      this.bot.on("polling_error", (error) => {
        this.pollingErrorCount++;

        logger.warn("Telegram polling error", {
          error: error.message,
          code: (error as NodeJS.ErrnoException).code,
          consecutiveErrors: this.pollingErrorCount,
        });

        // Handle rate limiting (429)
        if ((error as NodeJS.ErrnoException).code === "ETELEGRAM") {
          const match = error.message.match(/retry after (\d+)/i);
          if (match) {
            const retryAfter = parseInt(match[1], 10);
            logger.warn(`Rate limited, retry after ${retryAfter} seconds`);
          }
        }

        // Too many consecutive errors — restart polling
        if (this.pollingErrorCount >= this.maxPollingErrors) {
          logger.warn(
            `${this.pollingErrorCount} consecutive polling errors, restarting polling`
          );
          this.pollingErrorCount = 0;
          this.restartPolling();
        }
      });

      // NOW start polling with robust config
      if (this.usePolling) {
        await this.bot.startPolling({
          restart: true,
          polling: { params: { timeout: 30 } },
        });
        this.startHealthCheck();
        logger.info("Polling started with long-poll timeout=30s");
      }

      this.connected = true;
      logger.debug("Telegram provider connected", {
        polling: this.usePolling,
        chatId: this.chatId,
      });
    } catch (error) {
      logger.error("Failed to connect Telegram provider", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Disconnect from Telegram.
   */
  async disconnect(): Promise<void> {
    // Clear health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.bot) {
      if (this.usePolling) {
        try {
          await this.bot.stopPolling();
        } catch {
          // Ignore stop errors during disconnect
        }
      }
      this.bot.removeAllListeners();
      this.bot = null;
    }

    this.pendingRejections.clear();
    this.pendingQuestions.clear();
    this.pendingApprovalMessages.clear();
    this.pendingQuestionButtons.clear();
    this.storedPlans.clear();
    this.awaitingRejectionReason.clear();
    this.pollingErrorCount = 0;
    this.connected = false;

    logger.debug("Telegram provider disconnected");
  }

  /**
   * Check if the provider is connected.
   */
  isConnected(): boolean {
    return this.connected && this.bot !== null;
  }

  /**
   * Start periodic health check that verifies bot connectivity.
   * Runs every 60 seconds and restarts polling if the connection is broken.
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (!this.bot || !this.connected) return;

      try {
        await this.bot.getMe();
      } catch (error) {
        logger.warn("Health check failed, restarting polling", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.restartPolling();
      }
    }, 60_000);

    // Allow the process to exit even if the interval is active
    if (this.healthCheckInterval.unref) {
      this.healthCheckInterval.unref();
    }
  }

  /**
   * Restart polling after a failure. Stops existing polling (if any),
   * then starts fresh with the same robust config.
   */
  private restartPolling(): void {
    if (!this.bot) return;

    const bot = this.bot;

    (async () => {
      try {
        await bot.stopPolling();
      } catch {
        // Ignore errors when stopping — may already be stopped
      }

      try {
        await bot.startPolling({
          restart: true,
          polling: { params: { timeout: 30 } },
        });
        logger.info("Polling restarted successfully");
      } catch (error) {
        logger.error("Failed to restart polling", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  /**
   * Send a plan for approval with an inline keyboard.
   */
  async sendPlanForApproval(plan: PlanMessage): Promise<void> {
    if (!this.bot || !this.connected) {
      throw new Error("Telegram provider not connected");
    }

    // Store full plan for reference
    this.storedPlans.set(plan.planId, {
      planId: plan.planId,
      ticketId: plan.ticketId,
      ticketTitle: plan.ticketTitle,
      plan: plan.plan,
    });

    // Send header message
    const header = [
      "📋 *Plan Review*",
      `*Ticket:* ${escapeMarkdown(plan.ticketId)} - ${escapeMarkdown(plan.ticketTitle)}`,
    ].join("\n");

    logger.info("Sending plan to Telegram", {
      planId: plan.planId,
      ticketId: plan.ticketId,
      planLength: plan.plan.length,
    });

    try {
      await this.bot.sendMessage(this.chatId, header, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      logger.warn("Failed to send plan header with Markdown, retrying without", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Retry without parse_mode
      await this.bot.sendMessage(this.chatId, `📋 Plan Review\nTicket: ${plan.ticketId} - ${plan.ticketTitle}`);
    }

    // Send the full plan content, splitting into chunks if needed
    const planChunks = this.splitMessage(plan.plan, TELEGRAM_MESSAGE_LIMIT - 100);
    for (const chunk of planChunks) {
      try {
        await this.bot.sendMessage(this.chatId, chunk);
      } catch (error) {
        logger.warn("Failed to send plan chunk", {
          error: error instanceof Error ? error.message : String(error),
          chunkLength: chunk.length,
        });
      }
    }

    // Send approval inline keyboard
    try {
      const sentMessage = await this.bot.sendMessage(
        this.chatId,
        `[${plan.ticketId}] Approve this plan?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "\u2705 Approve", callback_data: `approve:${plan.planId}` },
                { text: "\u274C Reject", callback_data: `reject:${plan.planId}` },
                { text: "\uD83D\uDCAC Feedback", callback_data: `feedback:${plan.planId}` },
              ],
            ],
          },
        }
      );

      // Track the approval message for later editing
      this.pendingApprovalMessages.set(plan.planId, sentMessage.message_id);

      logger.info("Plan sent to Telegram with approval buttons", {
        planId: plan.planId,
        messageId: sentMessage.message_id,
        chunks: planChunks.length,
      });
    } catch (error) {
      logger.error("Failed to send plan approval buttons", {
        error: error instanceof Error ? error.message : String(error),
        planId: plan.planId,
      });
      throw error;
    }
  }

  /**
   * Send a question to the user.
   */
  async sendQuestion(question: QuestionMessage): Promise<void> {
    if (!this.bot || !this.connected) {
      throw new Error("Telegram provider not connected");
    }

    // Format question message
    const message = [
      "❓ *Question*",
      `*Ticket:* ${escapeMarkdown(question.ticketId)} \\- ${escapeMarkdown(question.ticketTitle)}`,
      "",
      escapeMarkdown(question.question),
    ].join("\n");

    try {
      if (question.options && question.options.length > 0) {
        // Build inline keyboard rows (one button per option)
        const keyboard = question.options.map((o) => [
          { text: o.label, callback_data: `answer:${question.questionId}:${o.value}` },
        ]);

        const sentMessage = await this.bot.sendMessage(
          this.chatId,
          `\u2753 *Question*\n*Ticket:* ${escapeMarkdown(question.ticketId)} \\- ${escapeMarkdown(question.ticketTitle)}\n\n${escapeMarkdown(question.question)}`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: keyboard,
            },
          }
        );

        // Track for callback handling
        this.pendingQuestionButtons.set(question.questionId, {
          questionId: question.questionId,
          messageId: sentMessage.message_id,
          options: question.options,
        });

        logger.info("Sent question as inline keyboard", {
          questionId: question.questionId,
          messageId: sentMessage.message_id,
        });
      } else {
        // No options - use force_reply for free text
        const sentMessage = await this.bot.sendMessage(
          this.chatId,
          message,
          {
            parse_mode: "Markdown",
            reply_markup: {
              force_reply: true,
              selective: true,
            },
          }
        );

        this.pendingQuestions.set(sentMessage.message_id, {
          questionId: question.questionId,
          messageId: sentMessage.message_id,
          options: question.options,
        });

        logger.info("Sent question as free text", {
          questionId: question.questionId,
          messageId: sentMessage.message_id,
        });
      }
    } catch (error) {
      logger.error("Failed to send question", {
        error: error instanceof Error ? error.message : String(error),
        questionId: question.questionId,
      });
      throw error;
    }
  }

  /**
   * Send a status update notification.
   */
  async sendStatus(status: StatusMessage): Promise<void> {
    if (!this.bot || !this.connected) {
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
      message += `\n\n⚠️ *Error:* ${escapeMarkdown(status.error)}`;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
      });

      logger.info("Sent status to Telegram", {
        ticketId: status.ticketId,
        status: status.status,
      });
    } catch (error) {
      logger.error("Failed to send status", {
        error: error instanceof Error ? error.message : String(error),
        ticketId: status.ticketId,
      });
      throw error;
    }
  }

  /**
   * Split a message into chunks that fit within Telegram's message limit.
   * Splits at newline boundaries when possible to preserve formatting.
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline boundary
      let splitIndex = remaining.lastIndexOf("\n", maxLength);
      if (splitIndex <= 0 || splitIndex < maxLength * 0.5) {
        // No good newline break, try space
        splitIndex = remaining.lastIndexOf(" ", maxLength);
      }
      if (splitIndex <= 0 || splitIndex < maxLength * 0.5) {
        // No good break point, hard split
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).replace(/^\n/, "");
    }

    return chunks;
  }

  /**
   * Handle callback query from inline keyboard buttons (approvals and questions).
   */
  private async handleCallbackQuery(
    query: TelegramBot.CallbackQuery
  ): Promise<void> {
    if (!this.bot || !query.data) return;

    // Reset error count on successful handler execution
    this.pollingErrorCount = 0;

    const respondedBy =
      query.from.username || query.from.first_name || String(query.from.id);
    const [action, ...rest] = query.data.split(":");

    logger.info("Callback query received", { action, data: query.data, respondedBy });

    // Acknowledge the callback (non-fatal — don't let this block approval)
    try {
      await this.bot.answerCallbackQuery(query.id);
    } catch (error) {
      logger.warn("Failed to acknowledge callback query", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Handle question answer callbacks: answer:questionId:value
    if (action === "answer") {
      const questionId = rest[0];
      const answerValue = rest.slice(1).join(":"); // value may contain colons

      if (!questionId) return;

      const pending = this.pendingQuestionButtons.get(questionId);
      const selectedOption = pending?.options?.find(
        (o) => o.value === answerValue
      );
      const displayLabel = selectedOption?.label || answerValue;

      // Fire response callback FIRST — critical path
      if (this.onQuestionResponse) {
        this.onQuestionResponse({
          questionId,
          answer: answerValue,
          respondedBy,
          respondedAt: new Date(),
        });
      }

      logger.info("Question answered via Telegram", {
        questionId,
        answer: answerValue,
        respondedBy,
      });

      // Then optional UI update
      if (pending) {
        try {
          await this.bot.editMessageText(
            `\u2705 Answer recorded: "${escapeMarkdown(displayLabel)}"`,
            {
              chat_id: this.chatId,
              message_id: pending.messageId,
              parse_mode: "Markdown",
            }
          );
        } catch (error) {
          logger.debug("Could not edit question message", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.pendingQuestionButtons.delete(questionId);
      }

      return;
    }

    // Handle approval callbacks: approve:planId, reject:planId, feedback:planId
    const planId = rest[0];
    if (!planId) return;

    if (action === "approve") {
      // Capture messageId BEFORE delete
      const messageId = this.pendingApprovalMessages.get(planId);
      this.pendingApprovalMessages.delete(planId);
      this.storedPlans.delete(planId);

      // Fire approval callback FIRST — critical path
      if (this.onApproval) {
        this.onApproval({
          planId,
          approved: true,
          respondedBy,
          respondedAt: new Date(),
        });
      }

      logger.info("Plan approved via Telegram", {
        planId,
        respondedBy,
      });

      // Then optional UI update
      if (messageId) {
        try {
          await this.bot.editMessageText(
            `\u2705 *Plan Approved* by @${escapeMarkdown(respondedBy)}`,
            {
              chat_id: this.chatId,
              message_id: messageId,
              parse_mode: "Markdown",
            }
          );
        } catch (error) {
          logger.debug("Could not edit approval message", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else if (action === "reject" || action === "feedback") {
      // Ask for reason via force_reply
      const userId = query.from.id;
      this.awaitingRejectionReason.set(userId, planId);

      const prompt =
        action === "reject"
          ? "Please reply with the rejection reason:"
          : "Please reply with your feedback:";

      logger.info("Rejection/feedback requested via Telegram", {
        planId,
        action,
        respondedBy,
      });

      const reasonMsg = await this.bot.sendMessage(
        this.chatId,
        `@${escapeMarkdown(respondedBy)} ${prompt}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            force_reply: true,
            selective: true,
          },
        }
      );

      this.pendingRejections.set(reasonMsg.message_id, {
        planId,
        messageId: reasonMsg.message_id,
      });
    }
  }

  /**
   * Handle incoming messages (for reply tracking).
   */
  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    if (!this.bot || !msg.text) return;

    // Reset error count on successful handler execution
    this.pollingErrorCount = 0;

    const userId = msg.from?.id;
    const username = msg.from?.username || msg.from?.first_name || String(userId);
    const replyToMessageId = msg.reply_to_message?.message_id;

    // Check if this is a reply to a rejection reason request
    if (userId && this.awaitingRejectionReason.has(userId)) {
      const planId = this.awaitingRejectionReason.get(userId)!;
      this.awaitingRejectionReason.delete(userId);

      await this.handleRejectionReason(planId, msg.text, username, replyToMessageId);
      return;
    }

    // Check if this is a reply to a rejection prompt message
    if (replyToMessageId && this.pendingRejections.has(replyToMessageId)) {
      const pending = this.pendingRejections.get(replyToMessageId)!;
      this.pendingRejections.delete(replyToMessageId);

      await this.handleRejectionReason(pending.planId, msg.text, username, pending.messageId);
      return;
    }

    // Check if this is a reply to a question (free text)
    if (replyToMessageId && this.pendingQuestions.has(replyToMessageId)) {
      const pending = this.pendingQuestions.get(replyToMessageId)!;
      this.pendingQuestions.delete(replyToMessageId);

      await this.handleFreeTextAnswer(pending.questionId, msg.text, username);
      return;
    }
  }

  /**
   * Process rejection with reason.
   */
  private async handleRejectionReason(
    planId: string,
    reason: string,
    respondedBy: string,
    originalMessageId?: number
  ): Promise<void> {
    if (!this.bot) return;

    // Edit original plan message to show rejection
    if (originalMessageId) {
      try {
        await this.bot.editMessageText(
          `❌ *Plan Rejected*\n_Reason: ${escapeMarkdown(reason)}_\n_By @${escapeMarkdown(respondedBy)}_`,
          {
            chat_id: this.chatId,
            message_id: originalMessageId,
            parse_mode: "Markdown",
          }
        );
      } catch (error) {
        // Message may already be edited, log and continue
        logger.debug("Could not edit original message", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Send confirmation
    await this.bot.sendMessage(
      this.chatId,
      `❌ Plan rejected with reason: "${escapeMarkdown(reason)}"`,
      { parse_mode: "Markdown" }
    );

    // Emit approval response with rejection
    if (this.onApproval) {
      this.onApproval({
        planId,
        approved: false,
        rejectionReason: reason,
        respondedBy,
        respondedAt: new Date(),
      });
    }

    // Clean up stored plan
    this.storedPlans.delete(planId);

    logger.debug("Plan rejected", { planId, reason, respondedBy });
  }

  /**
   * Handle free text answer to question.
   */
  private async handleFreeTextAnswer(
    questionId: string,
    answer: string,
    respondedBy: string
  ): Promise<void> {
    if (!this.bot) return;

    // Send confirmation
    await this.bot.sendMessage(
      this.chatId,
      `✅ Answer recorded: "${escapeMarkdown(truncateText(answer, 100))}"`,
      { parse_mode: "Markdown" }
    );

    // Emit question response
    if (this.onQuestionResponse) {
      this.onQuestionResponse({
        questionId,
        answer,
        respondedBy,
        respondedAt: new Date(),
      });
    }

    logger.debug("Free text answer received", { questionId, respondedBy });
  }
}

/**
 * Create a Telegram messaging provider.
 * @param config - Configuration options
 * @returns A MessagingProvider for Telegram interaction
 */
export function createTelegramProvider(
  config: TelegramProviderConfig
): MessagingProvider {
  return new TelegramProvider(config);
}
