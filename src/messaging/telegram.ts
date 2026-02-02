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
 * Plan content limit (leave room for header/footer).
 */
const PLAN_CONTENT_LIMIT = 3500;

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
 * Escape special characters for Telegram MarkdownV2.
 * @see https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

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

  /** Map of message ID to pending rejection for tracking rejection reasons */
  private pendingRejections: Map<number, PendingRejection> = new Map();
  /** Map of message ID to pending question for tracking question responses */
  private pendingQuestions: Map<number, PendingQuestion> = new Map();
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
   */
  async connect(): Promise<void> {
    if (this.connected) {
      logger.debug("Telegram provider already connected");
      return;
    }

    try {
      this.bot = new TelegramBot(this.botToken, {
        polling: this.usePolling,
      });

      // Register callback query handler for button presses
      this.bot.on("callback_query", (query) => {
        this.handleCallbackQuery(query).catch((error) => {
          logger.error("Error handling callback query", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      // Register message handler for replies
      this.bot.on("message", (msg) => {
        this.handleMessage(msg).catch((error) => {
          logger.error("Error handling message", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      // Handle polling errors
      this.bot.on("polling_error", (error) => {
        logger.error("Telegram polling error", {
          error: error.message,
          code: (error as NodeJS.ErrnoException).code,
        });

        // Handle rate limiting (429)
        if ((error as NodeJS.ErrnoException).code === "ETELEGRAM") {
          const match = error.message.match(/retry after (\d+)/i);
          if (match) {
            const retryAfter = parseInt(match[1], 10);
            logger.warn(`Rate limited, retry after ${retryAfter} seconds`);
          }
        }
      });

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
    if (this.bot) {
      if (this.usePolling) {
        this.bot.stopPolling();
      }
      this.bot.removeAllListeners();
      this.bot = null;
    }

    this.pendingRejections.clear();
    this.pendingQuestions.clear();
    this.storedPlans.clear();
    this.awaitingRejectionReason.clear();
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
   * Send a plan for approval with inline keyboard.
   */
  async sendPlanForApproval(plan: PlanMessage): Promise<void> {
    if (!this.bot || !this.connected) {
      throw new Error("Telegram provider not connected");
    }

    // Store full plan for view requests
    this.storedPlans.set(plan.planId, {
      planId: plan.planId,
      ticketId: plan.ticketId,
      ticketTitle: plan.ticketTitle,
      plan: plan.plan,
    });

    // Format message with Markdown
    const truncatedPlan = truncateText(plan.plan, PLAN_CONTENT_LIMIT);
    const message = [
      "📋 *Plan Review*",
      `*Ticket:* ${escapeMarkdown(plan.ticketId)} \\- ${escapeMarkdown(plan.ticketTitle)}`,
      "",
      escapeMarkdown(truncatedPlan),
    ].join("\n");

    // Create inline keyboard for approval actions
    const keyboard: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve_${plan.planId}` },
          { text: "❌ Reject", callback_data: `reject_${plan.planId}` },
        ],
        [{ text: "📄 View Full", callback_data: `view_${plan.planId}` }],
      ],
    };

    try {
      const sentMessage = await this.bot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });

      logger.debug("Sent plan for approval", {
        planId: plan.planId,
        messageId: sentMessage.message_id,
      });
    } catch (error) {
      logger.error("Failed to send plan for approval", {
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

    let keyboard: TelegramBot.InlineKeyboardMarkup | undefined;

    // If options provided, create inline keyboard buttons
    if (question.options && question.options.length > 0) {
      keyboard = {
        inline_keyboard: question.options.map((option) => [
          {
            text: option.label,
            callback_data: `answer_${question.questionId}_${option.value}`,
          },
        ]),
      };
    }

    try {
      const sentMessage = await this.bot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
        reply_markup: keyboard || {
          force_reply: true,
          selective: true,
        },
      });

      // Track question for reply handling (free text)
      if (!question.options || question.options.length === 0) {
        this.pendingQuestions.set(sentMessage.message_id, {
          questionId: question.questionId,
          messageId: sentMessage.message_id,
          options: question.options,
        });
      }

      logger.debug("Sent question", {
        questionId: question.questionId,
        messageId: sentMessage.message_id,
        hasOptions: Boolean(question.options?.length),
      });
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

      logger.debug("Sent status update", {
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
   * Handle callback queries from inline keyboard button presses.
   */
  private async handleCallbackQuery(
    query: TelegramBot.CallbackQuery
  ): Promise<void> {
    if (!this.bot || !query.data || !query.message) {
      return;
    }

    const data = query.data;
    const messageId = query.message.message_id;
    const userId = query.from.id;
    const username = query.from.username || query.from.first_name || String(userId);

    logger.debug("Received callback query", { data, messageId, userId });

    // Parse callback data
    if (data.startsWith("approve_")) {
      const planId = data.replace("approve_", "");
      await this.handleApproval(query, planId, username);
    } else if (data.startsWith("reject_")) {
      const planId = data.replace("reject_", "");
      await this.handleRejectionRequest(query, planId, userId, username);
    } else if (data.startsWith("view_")) {
      const planId = data.replace("view_", "");
      await this.handleViewFull(query, planId);
    } else if (data.startsWith("answer_")) {
      const parts = data.split("_");
      if (parts.length >= 3) {
        const questionId = parts[1];
        const answer = parts.slice(2).join("_");
        await this.handleQuestionAnswer(query, questionId, answer, username);
      }
    }
  }

  /**
   * Handle plan approval.
   */
  private async handleApproval(
    query: TelegramBot.CallbackQuery,
    planId: string,
    respondedBy: string
  ): Promise<void> {
    if (!this.bot || !query.message) return;

    // Answer callback query
    await this.bot.answerCallbackQuery(query.id, {
      text: "Plan approved!",
    });

    // Edit message to show approval status
    await this.bot.editMessageText(
      `✅ *Plan Approved*\n_Approved by @${escapeMarkdown(respondedBy)}_`,
      {
        chat_id: this.chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
      }
    );

    // Emit approval response
    if (this.onApproval) {
      this.onApproval({
        planId,
        approved: true,
        respondedBy,
        respondedAt: new Date(),
      });
    }

    // Clean up stored plan
    this.storedPlans.delete(planId);

    logger.debug("Plan approved", { planId, respondedBy });
  }

  /**
   * Handle rejection request - prompt for reason.
   */
  private async handleRejectionRequest(
    query: TelegramBot.CallbackQuery,
    planId: string,
    userId: number,
    username: string
  ): Promise<void> {
    if (!this.bot || !query.message) return;

    // Answer callback query
    await this.bot.answerCallbackQuery(query.id, {
      text: "Please reply with rejection reason",
    });

    // Store pending rejection state
    this.awaitingRejectionReason.set(userId, planId);

    // Send message requesting rejection reason
    const reasonMessage = await this.bot.sendMessage(
      this.chatId,
      `@${escapeMarkdown(username)} Please reply to this message with the rejection reason:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          force_reply: true,
          selective: true,
        },
      }
    );

    // Track for reply handling
    this.pendingRejections.set(reasonMessage.message_id, {
      planId,
      messageId: query.message.message_id,
    });

    logger.debug("Rejection reason requested", { planId, userId });
  }

  /**
   * Handle view full plan request.
   */
  private async handleViewFull(
    query: TelegramBot.CallbackQuery,
    planId: string
  ): Promise<void> {
    if (!this.bot) return;

    const storedPlan = this.storedPlans.get(planId);

    if (!storedPlan) {
      await this.bot.answerCallbackQuery(query.id, {
        text: "Plan no longer available",
        show_alert: true,
      });
      return;
    }

    await this.bot.answerCallbackQuery(query.id, {
      text: "Sending full plan...",
    });

    // Send full plan - split into multiple messages if needed
    const fullPlan = storedPlan.plan;

    if (fullPlan.length <= TELEGRAM_MESSAGE_LIMIT) {
      await this.bot.sendMessage(
        this.chatId,
        `📄 *Full Plan for ${escapeMarkdown(storedPlan.ticketId)}*\n\n${escapeMarkdown(fullPlan)}`,
        { parse_mode: "Markdown" }
      );
    } else {
      // Send as document for very long plans
      const buffer = Buffer.from(fullPlan, "utf-8");
      await this.bot.sendDocument(
        this.chatId,
        buffer,
        {
          caption: `Full plan for ${storedPlan.ticketId} - ${storedPlan.ticketTitle}`,
        },
        {
          filename: `plan-${storedPlan.ticketId}.txt`,
          contentType: "text/plain",
        }
      );
    }

    logger.debug("Sent full plan", { planId });
  }

  /**
   * Handle question answer from inline keyboard.
   */
  private async handleQuestionAnswer(
    query: TelegramBot.CallbackQuery,
    questionId: string,
    answer: string,
    respondedBy: string
  ): Promise<void> {
    if (!this.bot || !query.message) return;

    // Answer callback query
    await this.bot.answerCallbackQuery(query.id, {
      text: "Answer recorded",
    });

    // Edit message to show answer
    await this.bot.editMessageText(
      `✅ *Question Answered*\n_Answer: ${escapeMarkdown(answer)}_\n_By @${escapeMarkdown(respondedBy)}_`,
      {
        chat_id: this.chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
      }
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

    logger.debug("Question answered via button", { questionId, answer, respondedBy });
  }

  /**
   * Handle incoming messages (for reply tracking).
   */
  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    if (!this.bot || !msg.text) return;

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
