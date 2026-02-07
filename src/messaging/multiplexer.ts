import { EventEmitter } from "node:events";
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
 * Error thrown when an operation times out.
 */
export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly operation: "approval" | "question",
    public readonly id: string
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Configuration options for the multiplexer.
 */
export interface MultiplexerOptions {
  /** Timeout for approval requests in milliseconds (default: 24 hours) */
  approvalTimeout?: number;
  /** Timeout for question requests in milliseconds (default: 1 hour) */
  questionTimeout?: number;
}

/**
 * Internal tracking for pending approval requests.
 */
interface PendingApproval {
  planId: string;
  resolve: (response: ApprovalResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Internal tracking for pending question requests.
 */
interface PendingQuestion {
  questionId: string;
  resolve: (response: QuestionResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Events emitted by the multiplexer.
 */
export interface MultiplexerEvents {
  approval: [response: ApprovalResponse];
  "question-response": [response: QuestionResponse];
  error: [error: Error, provider?: string];
}

/**
 * Multiplexer that combines multiple messaging providers.
 * Broadcasts messages to all providers and returns the first response received.
 */
export interface Multiplexer extends EventEmitter<MultiplexerEvents> {
  /**
   * Add a messaging provider to the multiplexer.
   * @param provider - The provider to add
   */
  addProvider(provider: MessagingProvider): void;

  /**
   * Remove a provider by name.
   * @param name - The name of the provider to remove
   */
  removeProvider(name: string): void;

  /**
   * Connect all registered providers.
   * @throws Error if any provider fails to connect
   */
  connectAll(): Promise<void>;

  /**
   * Disconnect all registered providers.
   */
  disconnectAll(): Promise<void>;

  /**
   * Send a plan to all providers and wait for the first approval/rejection.
   * @param plan - The plan to request approval for
   * @returns The first approval response received
   * @throws TimeoutError if no response within timeout
   */
  requestApproval(plan: PlanMessage): Promise<ApprovalResponse>;

  /**
   * Send a question to all providers and wait for the first response.
   * @param question - The question to ask
   * @returns The first question response received
   * @throws TimeoutError if no response within timeout
   */
  askQuestion(question: QuestionMessage): Promise<QuestionResponse>;

  /**
   * Broadcast a status update to all providers.
   * @param status - The status message to broadcast
   */
  broadcastStatus(status: StatusMessage): Promise<void>;

  /**
   * Cancel a pending approval request.
   * @param planId - The ID of the plan to cancel
   */
  cancelApproval(planId: string): void;

  /**
   * Cancel a pending question.
   * @param questionId - The ID of the question to cancel
   */
  cancelQuestion(questionId: string): void;
}

// Default timeouts
const DEFAULT_APPROVAL_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_QUESTION_TIMEOUT = 60 * 60 * 1000; // 1 hour

/**
 * Implementation of the Multiplexer interface.
 */
class MultiplexerImpl
  extends EventEmitter<MultiplexerEvents>
  implements Multiplexer
{
  private readonly providers: Map<string, MessagingProvider> = new Map();
  private readonly pendingApprovals: Map<string, PendingApproval> = new Map();
  private readonly pendingQuestions: Map<string, PendingQuestion> = new Map();
  private readonly approvalTimeout: number;
  private readonly questionTimeout: number;

  constructor(options: MultiplexerOptions = {}) {
    super();
    this.approvalTimeout = options.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;
    this.questionTimeout = options.questionTimeout ?? DEFAULT_QUESTION_TIMEOUT;
  }

  addProvider(provider: MessagingProvider): void {
    if (this.providers.has(provider.name)) {
      logger.warn(`Provider "${provider.name}" already registered, replacing`, {
        provider: provider.name,
      });
    }

    // Wire up response handlers
    provider.onApproval = (response: ApprovalResponse) => {
      this.handleApprovalResponse(response, provider.name);
    };

    provider.onQuestionResponse = (response: QuestionResponse) => {
      this.handleQuestionResponse(response, provider.name);
    };

    this.providers.set(provider.name, provider);
    logger.debug(`Added messaging provider: ${provider.name}`);
  }

  removeProvider(name: string): void {
    const provider = this.providers.get(name);
    if (provider) {
      // Clear handlers
      provider.onApproval = undefined;
      provider.onQuestionResponse = undefined;
      this.providers.delete(name);
      logger.debug(`Removed messaging provider: ${name}`);
    }
  }

  async connectAll(): Promise<void> {
    const connectPromises = Array.from(this.providers.entries()).map(
      async ([name, provider]) => {
        try {
          await provider.connect();
          logger.info(`Connected to ${name}`);
        } catch (error) {
          const err =
            error instanceof Error ? error : new Error(String(error));
          logger.error(`Failed to connect to ${name}`, { error: err.message });
          throw err;
        }
      }
    );

    await Promise.all(connectPromises);
  }

  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.providers.entries()).map(
      async ([name, provider]) => {
        try {
          await provider.disconnect();
          logger.debug(`Disconnected from ${name}`);
        } catch (error) {
          const err =
            error instanceof Error ? error : new Error(String(error));
          logger.warn(`Error disconnecting from ${name}`, {
            error: err.message,
          });
        }
      }
    );

    await Promise.all(disconnectPromises);
  }

  async requestApproval(plan: PlanMessage): Promise<ApprovalResponse> {
    if (this.providers.size === 0) {
      throw new Error("No messaging providers registered");
    }

    return new Promise<ApprovalResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingApprovals.delete(plan.planId);
        const error = new TimeoutError(
          `Approval request timed out after ${this.approvalTimeout}ms`,
          "approval",
          plan.planId
        );
        this.emit("error", error);
        reject(error);
      }, this.approvalTimeout);

      // Register BEFORE broadcasting so callbacks can resolve immediately
      this.pendingApprovals.set(plan.planId, {
        planId: plan.planId,
        resolve,
        reject,
        timeoutId,
      });

      // Broadcast without awaiting — providers handle responses asynchronously
      this.broadcastPlan(plan).catch((err) => {
        logger.error("Failed to broadcast plan", {
          planId: plan.planId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  async askQuestion(question: QuestionMessage): Promise<QuestionResponse> {
    if (this.providers.size === 0) {
      throw new Error("No messaging providers registered");
    }

    return new Promise<QuestionResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingQuestions.delete(question.questionId);
        const error = new TimeoutError(
          `Question timed out after ${this.questionTimeout}ms`,
          "question",
          question.questionId
        );
        this.emit("error", error);
        reject(error);
      }, this.questionTimeout);

      // Register BEFORE broadcasting so callbacks can resolve immediately
      this.pendingQuestions.set(question.questionId, {
        questionId: question.questionId,
        resolve,
        reject,
        timeoutId,
      });

      // Broadcast without awaiting
      this.broadcastQuestion(question).catch((err) => {
        logger.error("Failed to broadcast question", {
          questionId: question.questionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  async broadcastStatus(status: StatusMessage): Promise<void> {
    const sendPromises = Array.from(this.providers.entries()).map(
      async ([name, provider]) => {
        if (!provider.isConnected()) {
          logger.warn(`Provider ${name} not connected, skipping status update`);
          return;
        }

        try {
          await provider.sendStatus(status);
        } catch (error) {
          const err =
            error instanceof Error ? error : new Error(String(error));
          logger.warn(`Failed to send status to ${name}`, {
            error: err.message,
          });
          this.emit("error", err, name);
        }
      }
    );

    await Promise.all(sendPromises);
  }

  cancelApproval(planId: string): void {
    const pending = this.pendingApprovals.get(planId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingApprovals.delete(planId);
      pending.reject(new Error(`Approval request cancelled: ${planId}`));
      logger.debug(`Cancelled approval request: ${planId}`);
    }
  }

  cancelQuestion(questionId: string): void {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingQuestions.delete(questionId);
      pending.reject(new Error(`Question cancelled: ${questionId}`));
      logger.debug(`Cancelled question: ${questionId}`);
    }
  }

  /**
   * Broadcast a plan to all connected providers.
   */
  private async broadcastPlan(plan: PlanMessage): Promise<void> {
    const sendPromises = Array.from(this.providers.entries()).map(
      async ([name, provider]) => {
        if (!provider.isConnected()) {
          logger.warn(`Provider ${name} not connected, skipping plan message`);
          return;
        }

        try {
          await provider.sendPlanForApproval(plan);
          logger.debug(`Sent plan for approval to ${name}`, {
            planId: plan.planId,
          });
        } catch (error) {
          const err =
            error instanceof Error ? error : new Error(String(error));
          logger.warn(`Failed to send plan to ${name}`, { error: err.message });
          this.emit("error", err, name);
        }
      }
    );

    await Promise.all(sendPromises);
  }

  /**
   * Broadcast a question to all connected providers.
   */
  private async broadcastQuestion(question: QuestionMessage): Promise<void> {
    const sendPromises = Array.from(this.providers.entries()).map(
      async ([name, provider]) => {
        if (!provider.isConnected()) {
          logger.warn(
            `Provider ${name} not connected, skipping question message`
          );
          return;
        }

        try {
          await provider.sendQuestion(question);
          logger.debug(`Sent question to ${name}`, {
            questionId: question.questionId,
          });
        } catch (error) {
          const err =
            error instanceof Error ? error : new Error(String(error));
          logger.warn(`Failed to send question to ${name}`, {
            error: err.message,
          });
          this.emit("error", err, name);
        }
      }
    );

    await Promise.all(sendPromises);
  }

  /**
   * Handle an approval response from a provider.
   * First response wins - subsequent responses are ignored.
   */
  private handleApprovalResponse(
    response: ApprovalResponse,
    providerName: string
  ): void {
    const pending = this.pendingApprovals.get(response.planId);
    if (!pending) {
      logger.debug(`Received approval for unknown/completed plan`, {
        planId: response.planId,
        provider: providerName,
      });
      return;
    }

    // First response wins
    clearTimeout(pending.timeoutId);
    this.pendingApprovals.delete(response.planId);

    logger.info(
      `Received ${response.approved ? "approval" : "rejection"} from ${providerName}`,
      {
        planId: response.planId,
        approved: response.approved,
      }
    );

    this.emit("approval", response);
    pending.resolve(response);
  }

  /**
   * Handle a question response from a provider.
   * First response wins - subsequent responses are ignored.
   */
  private handleQuestionResponse(
    response: QuestionResponse,
    providerName: string
  ): void {
    const pending = this.pendingQuestions.get(response.questionId);
    if (!pending) {
      logger.debug(`Received answer for unknown/completed question`, {
        questionId: response.questionId,
        provider: providerName,
      });
      return;
    }

    // First response wins
    clearTimeout(pending.timeoutId);
    this.pendingQuestions.delete(response.questionId);

    logger.info(`Received question response from ${providerName}`, {
      questionId: response.questionId,
    });

    this.emit("question-response", response);
    pending.resolve(response);
  }
}

/**
 * Create a new multiplexer instance.
 * @param options - Configuration options
 * @returns A new Multiplexer instance
 */
export function createMultiplexer(options?: MultiplexerOptions): Multiplexer {
  return new MultiplexerImpl(options);
}
