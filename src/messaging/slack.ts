import { WebClient, type ChatPostMessageResponse } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
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
 * Configuration for the Slack messaging provider.
 */
export interface SlackProviderConfig {
  /** Bot token (xoxb-...) for Web API calls */
  botToken: string;
  /** App-level token (xapp-...) for Socket Mode */
  appToken: string;
  /** Channel ID to send messages to */
  channel: string;
}

/**
 * Maximum character limit for Slack section blocks.
 */
const SLACK_SECTION_CHAR_LIMIT = 3000;

/**
 * Status emoji mapping for status updates.
 */
const STATUS_EMOJI: Record<StatusMessage["status"], string> = {
  started: ":rocket:",
  completed: ":white_check_mark:",
  failed: ":x:",
  skipped: ":fast_forward:",
};

/**
 * Tracking data for pending questions awaiting thread replies.
 */
interface PendingThreadQuestion {
  questionId: string;
  threadTs: string;
  channelId: string;
}

/**
 * Tracking data for sent messages that may need updates.
 */
interface SentMessage {
  ts: string;
  channelId: string;
}

/**
 * Slack messaging provider implementation using Socket Mode.
 * Handles plan approvals via interactive buttons and questions via thread replies.
 */
class SlackProvider implements MessagingProvider {
  readonly name = "slack";

  private webClient: WebClient | null = null;
  private socketClient: SocketModeClient | null = null;
  private readonly config: SlackProviderConfig;
  private connected = false;

  /** Track sent plan messages for updates */
  private readonly planMessages: Map<string, SentMessage> = new Map();

  /** Track pending questions awaiting thread replies */
  private readonly pendingQuestions: Map<string, PendingThreadQuestion> =
    new Map();

  /** Track thread timestamp to question ID mapping for thread replies */
  private readonly threadToQuestion: Map<string, string> = new Map();

  onApproval?: (response: ApprovalResponse) => void;
  onQuestionResponse?: (response: QuestionResponse) => void;

  constructor(config: SlackProviderConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      logger.warn("Slack provider already connected");
      return;
    }

    logger.debug("Initializing Slack clients");

    // Initialize Web API client
    this.webClient = new WebClient(this.config.botToken);

    // Initialize Socket Mode client
    this.socketClient = new SocketModeClient({
      appToken: this.config.appToken,
    });

    // Register event handlers before connecting
    this.registerEventHandlers();

    // Start socket mode connection
    try {
      await this.socketClient.start();
      this.connected = true;
      logger.info("Slack Socket Mode connected");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to start Slack Socket Mode", { error: err.message });
      this.cleanup();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    logger.debug("Disconnecting Slack provider");

    try {
      if (this.socketClient) {
        await this.socketClient.disconnect();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn("Error disconnecting Socket Mode", { error: err.message });
    }

    this.cleanup();
    logger.info("Slack provider disconnected");
  }

  isConnected(): boolean {
    return this.connected && this.socketClient?.websocket?.isActive() === true;
  }

  async sendPlanForApproval(plan: PlanMessage): Promise<void> {
    this.ensureConnected();

    const truncatedPlan = this.truncatePlan(plan.plan);
    const needsFileUpload = plan.plan.length > SLACK_SECTION_CHAR_LIMIT;

    const blocks = this.buildPlanBlocks(plan, truncatedPlan);

    try {
      const response = await this.postMessage({
        channel: this.config.channel,
        text: `Plan Review: ${plan.ticketTitle}`,
        blocks,
      });

      if (response.ts) {
        this.planMessages.set(plan.planId, {
          ts: response.ts,
          channelId: response.channel ?? this.config.channel,
        });
      }

      // If plan was truncated, upload full content as a file
      if (needsFileUpload && response.ts) {
        await this.uploadPlanAsFile(plan, response.ts);
      }

      logger.debug("Sent plan for approval to Slack", { planId: plan.planId });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to send plan to Slack", { error: err.message });
      throw err;
    }
  }

  async sendQuestion(question: QuestionMessage): Promise<void> {
    this.ensureConnected();

    const blocks = this.buildQuestionBlocks(question);

    try {
      const response = await this.postMessage({
        channel: this.config.channel,
        text: `Question: ${question.question}`,
        blocks,
      });

      if (response.ts) {
        // Track this question for thread reply handling
        const pending: PendingThreadQuestion = {
          questionId: question.questionId,
          threadTs: response.ts,
          channelId: response.channel ?? this.config.channel,
        };
        this.pendingQuestions.set(question.questionId, pending);
        this.threadToQuestion.set(response.ts, question.questionId);
      }

      logger.debug("Sent question to Slack", { questionId: question.questionId });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to send question to Slack", { error: err.message });
      throw err;
    }
  }

  async sendStatus(status: StatusMessage): Promise<void> {
    this.ensureConnected();

    const emoji = STATUS_EMOJI[status.status];
    const statusText = status.status.charAt(0).toUpperCase() + status.status.slice(1);

    let messageText = `${emoji} *${statusText}*: ${status.ticketTitle} (${status.ticketId})`;
    if (status.message) {
      messageText += `\n${status.message}`;
    }
    if (status.error) {
      messageText += `\n:warning: Error: ${status.error}`;
    }

    try {
      await this.postMessage({
        channel: this.config.channel,
        text: messageText,
        mrkdwn: true,
      });

      logger.debug("Sent status update to Slack", {
        ticketId: status.ticketId,
        status: status.status,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to send status to Slack", { error: err.message });
      throw err;
    }
  }

  /**
   * Register Socket Mode event handlers for interactive messages.
   */
  private registerEventHandlers(): void {
    if (!this.socketClient) {
      return;
    }

    // Handle interactive block actions (button clicks)
    this.socketClient.on("interactive", async ({ body, ack }) => {
      await ack();

      if (body.type === "block_actions" && body.actions) {
        for (const action of body.actions) {
          await this.handleBlockAction(action, body);
        }
      } else if (body.type === "view_submission") {
        await this.handleViewSubmission(body);
      }
    });

    // Handle message events for thread replies
    this.socketClient.on("message", async ({ event, ack }) => {
      await ack();
      await this.handleMessageEvent(event);
    });

    // Handle connection events
    this.socketClient.on("connected", () => {
      logger.debug("Slack Socket Mode reconnected");
      this.connected = true;
    });

    this.socketClient.on("disconnected", () => {
      logger.warn("Slack Socket Mode disconnected");
      this.connected = false;
    });
  }

  /**
   * Handle block action events (button clicks).
   */
  private async handleBlockAction(
    action: { action_id: string; value?: string },
    body: {
      user?: { id?: string; name?: string };
      message?: { ts?: string };
      channel?: { id?: string };
      trigger_id?: string;
    }
  ): Promise<void> {
    const actionId = action.action_id;

    // Parse action ID: approve_{planId}, reject_{planId}, view_full_{planId}
    if (actionId.startsWith("approve_")) {
      const planId = actionId.replace("approve_", "");
      await this.handleApprove(planId, body);
    } else if (actionId.startsWith("reject_")) {
      const planId = actionId.replace("reject_", "");
      await this.handleRejectClick(planId, body);
    } else if (actionId.startsWith("view_full_")) {
      const planId = actionId.replace("view_full_", "");
      await this.handleViewFull(planId, body);
    } else if (actionId.startsWith("select_option_")) {
      const questionId = actionId.replace("select_option_", "");
      await this.handleOptionSelect(questionId, action.value, body);
    }
  }

  /**
   * Handle approval button click.
   */
  private async handleApprove(
    planId: string,
    body: {
      user?: { id?: string; name?: string };
      message?: { ts?: string };
      channel?: { id?: string };
    }
  ): Promise<void> {
    const response: ApprovalResponse = {
      planId,
      approved: true,
      respondedBy: body.user?.name ?? body.user?.id,
      respondedAt: new Date(),
    };

    logger.info("Plan approved via Slack", { planId });

    // Update the original message to show approval
    await this.updatePlanMessage(planId, true);

    this.onApproval?.(response);
  }

  /**
   * Handle reject button click - opens modal for rejection reason.
   */
  private async handleRejectClick(
    planId: string,
    body: { trigger_id?: string }
  ): Promise<void> {
    if (!this.webClient || !body.trigger_id) {
      return;
    }

    try {
      await this.webClient.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: "modal",
          callback_id: `reject_modal_${planId}`,
          title: {
            type: "plain_text",
            text: "Reject Plan",
          },
          submit: {
            type: "plain_text",
            text: "Reject",
          },
          close: {
            type: "plain_text",
            text: "Cancel",
          },
          blocks: [
            {
              type: "input",
              block_id: "rejection_reason",
              label: {
                type: "plain_text",
                text: "Reason for rejection",
              },
              element: {
                type: "plain_text_input",
                action_id: "reason_input",
                multiline: true,
                placeholder: {
                  type: "plain_text",
                  text: "Please provide a reason for rejecting this plan...",
                },
              },
            },
          ],
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to open rejection modal", { error: err.message });
    }
  }

  /**
   * Handle modal submission for rejection reason.
   */
  private async handleViewSubmission(body: {
    view?: {
      callback_id?: string;
      state?: {
        values?: Record<string, Record<string, { value?: string }>>;
      };
    };
    user?: { id?: string; name?: string };
  }): Promise<void> {
    const callbackId = body.view?.callback_id;
    if (!callbackId?.startsWith("reject_modal_")) {
      return;
    }

    const planId = callbackId.replace("reject_modal_", "");
    const reason =
      body.view?.state?.values?.rejection_reason?.reason_input?.value ?? "";

    const response: ApprovalResponse = {
      planId,
      approved: false,
      rejectionReason: reason,
      respondedBy: body.user?.name ?? body.user?.id,
      respondedAt: new Date(),
    };

    logger.info("Plan rejected via Slack", { planId, reason });

    // Update the original message to show rejection
    await this.updatePlanMessage(planId, false, reason);

    this.onApproval?.(response);
  }

  /**
   * Handle "View Full" button click - provides info about file.
   */
  private async handleViewFull(
    planId: string,
    body: { user?: { id?: string }; channel?: { id?: string } }
  ): Promise<void> {
    // The full plan was uploaded as a file snippet in the thread
    // Just acknowledge - the file is already visible in the thread
    if (body.user?.id && this.webClient) {
      try {
        await this.webClient.chat.postEphemeral({
          channel: body.channel?.id ?? this.config.channel,
          user: body.user.id,
          text: "The full plan is available as a file attachment in this message thread.",
        });
      } catch (error) {
        // Ephemeral message failure is non-critical
        logger.debug("Failed to send ephemeral message", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle option selection for questions with predefined options.
   */
  private async handleOptionSelect(
    questionId: string,
    value: string | undefined,
    body: { user?: { id?: string; name?: string } }
  ): Promise<void> {
    if (!value) {
      return;
    }

    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      logger.debug("Received option select for unknown question", { questionId });
      return;
    }

    const response: QuestionResponse = {
      questionId,
      answer: value,
      respondedBy: body.user?.name ?? body.user?.id,
      respondedAt: new Date(),
    };

    // Clean up tracking
    this.pendingQuestions.delete(questionId);
    this.threadToQuestion.delete(pending.threadTs);

    logger.info("Question answered via Slack option", { questionId });

    this.onQuestionResponse?.(response);
  }

  /**
   * Handle message events for thread replies to questions.
   */
  private async handleMessageEvent(event: {
    type?: string;
    subtype?: string;
    thread_ts?: string;
    text?: string;
    user?: string;
  }): Promise<void> {
    // Only handle thread replies, not bot messages
    if (event.subtype === "bot_message" || !event.thread_ts || !event.text) {
      return;
    }

    const questionId = this.threadToQuestion.get(event.thread_ts);
    if (!questionId) {
      return; // Not a thread we're tracking
    }

    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      return;
    }

    // Get user info for respondedBy
    let respondedBy: string | undefined;
    if (event.user && this.webClient) {
      try {
        const userInfo = await this.webClient.users.info({ user: event.user });
        respondedBy =
          (userInfo.user as { real_name?: string; name?: string })?.real_name ??
          (userInfo.user as { real_name?: string; name?: string })?.name ??
          event.user;
      } catch {
        respondedBy = event.user;
      }
    }

    const response: QuestionResponse = {
      questionId,
      answer: event.text,
      respondedBy,
      respondedAt: new Date(),
    };

    // Clean up tracking
    this.pendingQuestions.delete(questionId);
    this.threadToQuestion.delete(event.thread_ts);

    logger.info("Question answered via Slack thread reply", { questionId });

    this.onQuestionResponse?.(response);
  }

  /**
   * Update a plan message to show approval/rejection result.
   */
  private async updatePlanMessage(
    planId: string,
    approved: boolean,
    reason?: string
  ): Promise<void> {
    const message = this.planMessages.get(planId);
    if (!message || !this.webClient) {
      return;
    }

    const resultEmoji = approved ? ":white_check_mark:" : ":x:";
    const resultText = approved ? "Approved" : "Rejected";
    let statusText = `${resultEmoji} *${resultText}*`;
    if (reason) {
      statusText += `\nReason: ${reason}`;
    }

    try {
      await this.webClient.chat.update({
        channel: message.channelId,
        ts: message.ts,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: statusText,
            },
          },
        ],
        text: `Plan ${resultText.toLowerCase()}`,
      });

      // Clean up tracking
      this.planMessages.delete(planId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn("Failed to update plan message", { error: err.message });
    }
  }

  /**
   * Build Block Kit blocks for plan approval message.
   */
  private buildPlanBlocks(
    plan: PlanMessage,
    truncatedPlan: string
  ): Array<Record<string, unknown>> {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Plan Review: ${plan.ticketTitle}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Ticket ID:* ${plan.ticketId}`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncatedPlan,
        },
      },
      {
        type: "actions",
        block_id: `plan_approval_${plan.planId}`,
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Approve",
              emoji: true,
            },
            style: "primary",
            action_id: `approve_${plan.planId}`,
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Reject",
              emoji: true,
            },
            style: "danger",
            action_id: `reject_${plan.planId}`,
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "View Full",
              emoji: true,
            },
            action_id: `view_full_${plan.planId}`,
          },
        ],
      },
    ];
  }

  /**
   * Build Block Kit blocks for question message.
   */
  private buildQuestionBlocks(
    question: QuestionMessage
  ): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Question: ${question.ticketTitle}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Ticket ID:* ${question.ticketId}`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: question.question,
        },
      },
    ];

    // If options provided, add buttons or select menu
    if (question.options && question.options.length > 0) {
      if (question.options.length <= 5) {
        // Use buttons for 5 or fewer options
        blocks.push({
          type: "actions",
          block_id: `question_${question.questionId}`,
          elements: question.options.map((opt) => ({
            type: "button",
            text: {
              type: "plain_text",
              text: opt.label,
              emoji: true,
            },
            value: opt.value,
            action_id: `select_option_${question.questionId}`,
          })),
        });
      } else {
        // Use select menu for more than 5 options
        blocks.push({
          type: "actions",
          block_id: `question_${question.questionId}`,
          elements: [
            {
              type: "static_select",
              placeholder: {
                type: "plain_text",
                text: "Select an option",
              },
              action_id: `select_option_${question.questionId}`,
              options: question.options.map((opt) => ({
                text: {
                  type: "plain_text",
                  text: opt.label,
                },
                value: opt.value,
              })),
            },
          ],
        });
      }
    } else {
      // Free text response - instruct to reply in thread
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: ":speech_balloon: Reply to this message in a thread to answer.",
          },
        ],
      });
    }

    return blocks;
  }

  /**
   * Truncate plan text to fit within Slack's section character limit.
   */
  private truncatePlan(plan: string): string {
    if (plan.length <= SLACK_SECTION_CHAR_LIMIT) {
      return plan;
    }

    const truncated = plan.slice(0, SLACK_SECTION_CHAR_LIMIT - 50);
    return `${truncated}\n\n_... (truncated - click "View Full" for complete plan)_`;
  }

  /**
   * Upload the full plan as a file snippet in a thread.
   */
  private async uploadPlanAsFile(
    plan: PlanMessage,
    threadTs: string
  ): Promise<void> {
    if (!this.webClient) {
      return;
    }

    try {
      await this.webClient.files.uploadV2({
        channel_id: this.config.channel,
        thread_ts: threadTs,
        filename: `plan-${plan.planId}.md`,
        content: plan.plan,
        title: `Full Plan: ${plan.ticketTitle}`,
        initial_comment: "Full plan content attached above.",
      });

      logger.debug("Uploaded full plan as file", { planId: plan.planId });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn("Failed to upload plan file", { error: err.message });
      // Non-critical - the truncated version is still visible
    }
  }

  /**
   * Post a message with rate limit retry handling.
   */
  private async postMessage(options: {
    channel: string;
    text: string;
    blocks?: Array<Record<string, unknown>>;
    mrkdwn?: boolean;
  }): Promise<ChatPostMessageResponse> {
    if (!this.webClient) {
      throw new Error("Web client not initialized");
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.webClient.chat.postMessage(options);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check for rate limiting
        if (
          lastError.message.includes("ratelimited") ||
          lastError.message.includes("rate_limited")
        ) {
          const retryAfter = this.extractRetryAfter(lastError) ?? (attempt + 1) * 1000;
          logger.warn(`Rate limited, retrying after ${retryAfter}ms`, {
            attempt: attempt + 1,
          });
          await this.sleep(retryAfter);
          continue;
        }

        // Non-retryable error
        throw lastError;
      }
    }

    throw lastError ?? new Error("Failed to post message after retries");
  }

  /**
   * Extract retry-after duration from rate limit error.
   */
  private extractRetryAfter(error: Error): number | null {
    // Slack errors often include retryAfter property
    const slackError = error as Error & { retryAfter?: number };
    if (slackError.retryAfter) {
      return slackError.retryAfter * 1000; // Convert to milliseconds
    }

    // Try parsing from message
    const match = error.message.match(/retry after (\d+)/i);
    if (match) {
      return parseInt(match[1], 10) * 1000;
    }

    return null;
  }

  /**
   * Sleep for a specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Ensure the provider is connected before operations.
   */
  private ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error("Slack provider not connected");
    }
  }

  /**
   * Clean up internal state.
   */
  private cleanup(): void {
    this.webClient = null;
    this.socketClient = null;
    this.connected = false;
    this.planMessages.clear();
    this.pendingQuestions.clear();
    this.threadToQuestion.clear();
  }
}

/**
 * Create a Slack messaging provider instance.
 * @param config - Configuration for the Slack provider
 * @returns A new SlackProvider implementing MessagingProvider
 */
export function createSlackProvider(config: SlackProviderConfig): MessagingProvider {
  return new SlackProvider(config);
}
