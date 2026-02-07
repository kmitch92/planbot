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
 * Wrap a promise with a timeout. Rejects with a descriptive error if the promise
 * doesn't resolve within the specified duration.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
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
  /** Timestamp of last received update (message or callback) */
  private lastUpdateReceived = 0;
  /** Consecutive health check failures */
  private consecutiveHealthFailures = 0;
  /** Set of processed callback query IDs to prevent duplicate handling */
  private processedCallbacks = new Set<string>();
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

        // Flush stale updates from previous sessions
        // getUpdates with offset -1 marks all pending updates as read
        try {
          const stale = await this.bot.getUpdates({ offset: -1, limit: 1 });
          if (stale.length > 0) {
            // Acknowledge the last update to clear the queue
            await this.bot.getUpdates({ offset: stale[stale.length - 1].update_id + 1, limit: 0 });
            logger.info('Flushed stale Telegram updates', { count: stale.length });
          }
        } catch (error) {
          logger.warn('Failed to flush stale updates', {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        logger.info("Cleared webhook before starting polling");
      }

      // Register ALL event handlers before polling begins
      this.bot.on("message", (msg) => {
        return this.handleMessage(msg).catch((error) => {
          logger.error("Error handling message", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      this.bot.on("callback_query", (query) => {
        return this.handleCallbackQuery(query).catch((error) => {
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
      this.lastUpdateReceived = Date.now();
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
    this.processedCallbacks.clear();
    this.pollingErrorCount = 0;
    this.consecutiveHealthFailures = 0;
    this.lastUpdateReceived = 0;
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
   * Start polling watchdog that monitors for stale polling connections.
   * If the bot has pending work (approval messages or question buttons)
   * and no updates have been received for 90 seconds, restarts polling.
   * Also falls back to getMe() check for general connectivity.
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (!this.bot || !this.connected) return;

      const hasPendingWork = this.pendingApprovalMessages.size > 0
        || this.pendingQuestionButtons.size > 0
        || this.pendingQuestions.size > 0;

      const timeSinceUpdate = Date.now() - this.lastUpdateReceived;

      // If we have pending work and no updates for 90 seconds, polling is likely dead
      if (hasPendingWork && this.lastUpdateReceived > 0 && timeSinceUpdate > 90_000) {
        logger.warn('Polling watchdog: no updates received while work pending, restarting polling', {
          timeSinceUpdateMs: timeSinceUpdate,
          pendingApprovals: this.pendingApprovalMessages.size,
          pendingQuestions: this.pendingQuestionButtons.size + this.pendingQuestions.size,
        });
        this.restartPolling();
        return;
      }

      // General connectivity check
      try {
        await this.bot.getMe();
        this.consecutiveHealthFailures = 0;
      } catch (error) {
        this.consecutiveHealthFailures++;

        if (this.consecutiveHealthFailures >= 3) {
          logger.warn('Multiple health check failures, recreating bot instance', {
            failures: this.consecutiveHealthFailures,
            error: error instanceof Error ? error.message : String(error),
          });
          this.consecutiveHealthFailures = 0;
          await this.recreateBot();
        } else {
          logger.warn('Health check failed, restarting polling', {
            failures: this.consecutiveHealthFailures,
            error: error instanceof Error ? error.message : String(error),
          });
          this.restartPolling();
        }
      }
    }, 30_000); // Check every 30 seconds (was 60s)

    // Allow the process to exit even if the interval is active
    if (this.healthCheckInterval.unref) {
      this.healthCheckInterval.unref();
    }
  }

  /**
   * Restart polling after a failure or stale detection.
   * Stops existing polling, waits briefly, then starts fresh.
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

      // Brief delay to allow TCP connections to fully close
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        await bot.startPolling({
          restart: true,
          polling: { params: { timeout: 30 } },
        });
        this.lastUpdateReceived = Date.now(); // Reset watchdog timer
        logger.info("Polling restarted successfully");
      } catch (error) {
        logger.error("Failed to restart polling", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  /**
   * Nuclear restart: destroy and recreate the entire bot instance.
   * Used when the HTTP connection pool is broken beyond what restartPolling can fix.
   */
  private async recreateBot(): Promise<void> {
    if (!this.bot) return;

    logger.info('Recreating Telegram bot instance');

    // Stop and remove old bot
    try {
      await this.bot.stopPolling();
    } catch {
      // Ignore
    }
    this.bot.removeAllListeners();

    // Create fresh bot instance
    this.bot = new TelegramBot(this.botToken, { polling: false });

    // Delete webhook on fresh instance
    try {
      await this.bot.deleteWebHook();
    } catch {
      // Ignore
    }

    // Re-register event handlers
    this.bot.on('message', (msg) => {
      this.handleMessage(msg).catch((error) => {
        logger.error('Error handling message', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    this.bot.on('callback_query', (query) => {
      this.handleCallbackQuery(query).catch((error) => {
        logger.error('Error handling callback query', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    this.bot.on('polling_error', (error) => {
      this.pollingErrorCount++;
      logger.warn('Telegram polling error', {
        error: error.message,
        code: (error as NodeJS.ErrnoException).code,
        consecutiveErrors: this.pollingErrorCount,
      });

      if ((error as NodeJS.ErrnoException).code === 'ETELEGRAM') {
        const match = error.message.match(/retry after (\d+)/i);
        if (match) {
          logger.warn(`Rate limited, retry after ${parseInt(match[1], 10)} seconds`);
        }
      }

      if (this.pollingErrorCount >= this.maxPollingErrors) {
        logger.warn(`${this.pollingErrorCount} consecutive polling errors, restarting polling`);
        this.pollingErrorCount = 0;
        this.restartPolling();
      }
    });

    // Start polling on fresh instance
    try {
      await this.bot.startPolling({
        restart: true,
        polling: { params: { timeout: 30 } },
      });
      this.lastUpdateReceived = Date.now();
      this.pollingErrorCount = 0;
      logger.info('Bot instance recreated and polling started');
    } catch (error) {
      logger.error('Failed to start polling on recreated bot', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

    // Ensure polling is fresh before sending approval request
    if (this.usePolling && this.bot) {
      try {
        await this.bot.stopPolling();
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.bot.startPolling({
          restart: true,
          polling: { params: { timeout: 30 } },
        });
        this.lastUpdateReceived = Date.now();
        logger.info("Polling refreshed before approval request");
      } catch (error) {
        logger.warn("Failed to refresh polling before approval", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Step 1: Send header
    logger.info("Sending plan header to Telegram");
    try {
      await withTimeout(
        this.bot.sendMessage(this.chatId, header, { parse_mode: "Markdown" }),
        15000,
        "Send plan header"
      );
    } catch (error) {
      logger.warn("Failed to send plan header with Markdown, retrying as plain text", {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await withTimeout(
          this.bot.sendMessage(this.chatId, `📋 Plan Review\nTicket: ${plan.ticketId} - ${plan.ticketTitle}`),
          15000,
          "Send plan header (plain)"
        );
      } catch (retryError) {
        logger.error("Failed to send plan header even as plain text", {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        throw retryError;
      }
    }

    // Step 2: Send plan content chunks
    const planChunks = this.splitMessage(plan.plan, TELEGRAM_MESSAGE_LIMIT - 100);
    logger.info("Sending plan content", { chunks: planChunks.length });
    for (let i = 0; i < planChunks.length; i++) {
      try {
        await withTimeout(
          this.bot.sendMessage(this.chatId, planChunks[i]),
          15000,
          `Send plan chunk ${i + 1}/${planChunks.length}`
        );
      } catch (error) {
        logger.warn("Failed to send plan chunk", {
          error: error instanceof Error ? error.message : String(error),
          chunk: i + 1,
          total: planChunks.length,
        });
      }
    }

    // Step 3: Send approval inline keyboard
    logger.info("Sending approval buttons");
    try {
      const sentMessage = await withTimeout(
        this.bot.sendMessage(
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
        ),
        15000,
        "Send approval buttons"
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

    // Validate chat ID — reject events from unauthorized chats
    const incomingChatId = query.message?.chat?.id;
    if (incomingChatId?.toString() !== this.chatId) {
      logger.warn('Rejected callback query from unauthorized chat', {
        chatId: incomingChatId,
        expectedChatId: this.chatId,
        from: query.from?.username || query.from?.first_name || String(query.from?.id),
      });
      return;
    }

    // Deduplicate — skip callbacks we've already processed (replayed after polling restart)
    if (this.processedCallbacks.has(query.id)) {
      logger.debug('Skipping duplicate callback query', { queryId: query.id });
      return;
    }
    this.processedCallbacks.add(query.id);

    // Limit memory usage — keep only last 100 callback IDs
    if (this.processedCallbacks.size > 100) {
      const entries = [...this.processedCallbacks];
      this.processedCallbacks = new Set(entries.slice(-50));
    }

    // Reset error count on successful handler execution
    this.pollingErrorCount = 0;
    this.lastUpdateReceived = Date.now();

    // Validate callback data format
    const callbackDataPattern = /^(approve|reject|feedback|answer):[a-zA-Z0-9_-]+(:[a-zA-Z0-9_:.-]*)?$/;
    if (!callbackDataPattern.test(query.data)) {
      logger.warn('Rejected callback query with invalid data format', {
        data: query.data.slice(0, 100),
        from: query.from?.username || query.from?.first_name || String(query.from?.id),
      });
      return;
    }

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

      try {
        const reasonMsg = await this.bot.sendMessage(
          this.chatId,
          `@${respondedBy} ${prompt}`,
          {
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
      } catch (error) {
        logger.warn("Failed to send feedback prompt, rejecting plan directly", {
          error: error instanceof Error ? error.message : String(error),
          planId,
        });
        // Fall back to immediate rejection without reason
        if (this.onApproval) {
          this.onApproval({
            planId,
            approved: false,
            rejectionReason: `${action} requested by ${respondedBy} (feedback prompt failed)`,
            respondedBy,
            respondedAt: new Date(),
          });
        }
        this.pendingApprovalMessages.delete(planId);
        this.storedPlans.delete(planId);
        this.awaitingRejectionReason.delete(userId);
      }
    }
  }

  /**
   * Handle incoming messages (for reply tracking).
   */
  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    if (!this.bot || !msg.text) return;

    // Validate chat ID — reject events from unauthorized chats
    const incomingChatId = msg.chat?.id?.toString();
    if (incomingChatId !== this.chatId) {
      logger.warn('Rejected message from unauthorized chat', {
        incomingChatId,
        expectedChatId: this.chatId,
        from: msg.from?.username || msg.from?.first_name || String(msg.from?.id),
      });
      return;
    }

    // Reset error count on successful handler execution
    this.pollingErrorCount = 0;
    this.lastUpdateReceived = Date.now();

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
