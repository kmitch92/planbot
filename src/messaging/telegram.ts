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
  /** Map of poll ID to pending poll for tracking poll responses */
  private pendingPolls: Map<string,
    | { type: "question"; questionId: string; options: Array<{ label: string; value: string }> }
    | { type: "approval"; planId: string; options: Array<{ label: string; value: string }> }
  > = new Map();
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

      // Register message handler for replies
      this.bot.on("message", (msg) => {
        this.handleMessage(msg).catch((error) => {
          logger.error("Error handling message", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      // Register poll answer handler for native polls
      this.bot.on("poll_answer", (answer) => {
        this.handlePollAnswer(answer).catch((error) => {
          logger.error("Error handling poll answer", {
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
    this.pendingPolls.clear();
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
   * Send a plan for approval with an approval poll.
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
      `*Ticket:* ${escapeMarkdown(plan.ticketId)} \\- ${escapeMarkdown(plan.ticketTitle)}`,
    ].join("\n");

    await this.bot.sendMessage(this.chatId, header, {
      parse_mode: "Markdown",
    });

    // Send the full plan content
    if (plan.plan.length <= PLAN_CONTENT_LIMIT) {
      await this.bot.sendMessage(
        this.chatId,
        escapeMarkdown(plan.plan),
        { parse_mode: "Markdown" }
      );
    } else {
      // Send as document for very long plans
      const buffer = Buffer.from(plan.plan, "utf-8");
      await this.bot.sendDocument(
        this.chatId,
        buffer,
        {
          caption: `Full plan for ${plan.ticketId} - ${plan.ticketTitle}`,
        },
        {
          filename: `plan-${plan.ticketId}.txt`,
          contentType: "text/plain",
        }
      );
    }

    // Send approval poll
    const approvalOptions = [
      { label: "Approve", value: "approve" },
      { label: "Reject", value: "reject" },
      { label: "Provide Feedback", value: "feedback" },
    ];

    try {
      const sentPoll = await this.bot.sendPoll(
        this.chatId,
        `[${plan.ticketId}] Approve this plan?`,
        approvalOptions.map((o) => o.label),
        {
          is_anonymous: false,
          allows_multiple_answers: false,
        }
      );

      if (sentPoll.poll) {
        this.pendingPolls.set(sentPoll.poll.id, {
          type: "approval",
          planId: plan.planId,
          options: approvalOptions,
        });
      }

      logger.debug("Sent plan for approval with poll", {
        planId: plan.planId,
        pollId: sentPoll.poll?.id,
      });
    } catch (error) {
      logger.error("Failed to send plan approval poll", {
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
        // Send ticket context before the poll
        const contextMessage = [
          "❓ *Question*",
          `*Ticket:* ${escapeMarkdown(question.ticketId)} \\- ${escapeMarkdown(question.ticketTitle)}`,
        ].join("\n");

        await this.bot.sendMessage(this.chatId, contextMessage, {
          parse_mode: "Markdown",
        });

        const optionLabels = question.options.map((o) => o.label);

        const sentMessage = await this.bot.sendPoll(
          this.chatId,
          `[${question.ticketId}] ${question.question}`,
          optionLabels,
          {
            is_anonymous: false,
            allows_multiple_answers: false,
          }
        );

        if (sentMessage.poll) {
          this.pendingPolls.set(sentMessage.poll.id, {
            type: "question",
            questionId: question.questionId,
            options: question.options,
          });
        }

        logger.debug("Sent question as poll", {
          questionId: question.questionId,
          pollId: sentMessage.poll?.id,
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

        logger.debug("Sent question as free text", {
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
   * Handle poll answer from native Telegram poll (questions and approvals).
   */
  private async handlePollAnswer(
    pollAnswer: TelegramBot.PollAnswer
  ): Promise<void> {
    const pollId = pollAnswer.poll_id;
    const pending = this.pendingPolls.get(pollId);

    if (!pending) {
      logger.debug("Received poll answer for unknown poll", { pollId });
      return;
    }

    const selectedIndex = pollAnswer.option_ids[0];
    if (selectedIndex === undefined || selectedIndex >= pending.options.length) {
      logger.warn("Invalid poll answer index", { pollId, selectedIndex });
      return;
    }

    const selectedOption = pending.options[selectedIndex];
    const respondedBy = pollAnswer.user.username || pollAnswer.user.first_name || String(pollAnswer.user.id);

    this.pendingPolls.delete(pollId);

    if (pending.type === "question") {
      // Question poll answer
      if (this.bot) {
        await this.bot.sendMessage(
          this.chatId,
          `✅ Answer recorded: "${escapeMarkdown(selectedOption.label)}"`,
          { parse_mode: "Markdown" }
        );
      }

      if (this.onQuestionResponse) {
        this.onQuestionResponse({
          questionId: pending.questionId,
          answer: selectedOption.value,
          respondedBy,
          respondedAt: new Date(),
        });
      }

      logger.debug("Poll answer received", {
        questionId: pending.questionId,
        answer: selectedOption.value,
        respondedBy,
      });
    } else if (pending.type === "approval") {
      // Approval poll answer
      if (selectedOption.value === "approve") {
        if (this.bot) {
          await this.bot.sendMessage(
            this.chatId,
            `✅ *Plan Approved* by @${escapeMarkdown(respondedBy)}`,
            { parse_mode: "Markdown" }
          );
        }

        if (this.onApproval) {
          this.onApproval({
            planId: pending.planId,
            approved: true,
            respondedBy,
            respondedAt: new Date(),
          });
        }

        this.storedPlans.delete(pending.planId);
        logger.debug("Plan approved via poll", { planId: pending.planId, respondedBy });
      } else {
        // Reject or Provide Feedback - ask for reason via reply
        const userId = pollAnswer.user.id;
        this.awaitingRejectionReason.set(userId, pending.planId);

        const prompt = selectedOption.value === "reject"
          ? "Please reply with the rejection reason:"
          : "Please reply with your feedback:";

        if (this.bot) {
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
            planId: pending.planId,
            messageId: reasonMsg.message_id,
          });
        }

        logger.debug("Awaiting rejection/feedback reason", {
          planId: pending.planId,
          action: selectedOption.value,
          respondedBy,
        });
      }
    }
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
