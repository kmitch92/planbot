/**
 * Common interface for all messaging providers.
 * Providers handle communication with users for plan approvals, questions, and status updates.
 */

/**
 * Message sent to request approval for a generated plan.
 */
export interface PlanMessage {
  /** Unique identifier for tracking this approval request */
  planId: string;
  /** ID of the ticket this plan addresses */
  ticketId: string;
  /** Short title of the ticket */
  ticketTitle: string;
  /** The generated plan content */
  plan: string;
}

/**
 * Message sent to ask a question requiring user input.
 */
export interface QuestionMessage {
  /** Unique identifier for this question */
  questionId: string;
  /** ID of the ticket that generated the question */
  ticketId: string;
  /** Short title of the ticket */
  ticketTitle: string;
  /** The question text */
  question: string;
  /** Optional predefined answer options */
  options?: Array<{ label: string; value: string }>;
}

/**
 * Response to a plan approval request.
 */
export interface ApprovalResponse {
  /** ID of the plan being responded to */
  planId: string;
  /** Whether the plan was approved */
  approved: boolean;
  /** Reason provided if plan was rejected */
  rejectionReason?: string;
  /** Identity of the user who responded (provider-specific) */
  respondedBy?: string;
  /** Timestamp when the response was received */
  respondedAt: Date;
}

/**
 * Response to a question.
 */
export interface QuestionResponse {
  /** ID of the question being answered */
  questionId: string;
  /** The user's answer */
  answer: string;
  /** Identity of the user who responded (provider-specific) */
  respondedBy?: string;
  /** Timestamp when the response was received */
  respondedAt: Date;
}

/**
 * Status update message sent to notify users of ticket progress.
 */
export interface StatusMessage {
  /** ID of the ticket */
  ticketId: string;
  /** Short title of the ticket */
  ticketTitle: string;
  /** Current status of the ticket */
  status: "started" | "completed" | "failed" | "skipped";
  /** Optional message providing additional context */
  message?: string;
  /** Error details if status is 'failed' */
  error?: string;
}

/**
 * Interface that all messaging providers must implement.
 * Providers handle sending messages to users and receiving responses.
 */
export interface MessagingProvider {
  /** Unique name identifying this provider (e.g., 'slack', 'discord') */
  readonly name: string;

  // Lifecycle methods

  /**
   * Establish connection to the messaging service.
   * @throws Error if connection fails
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the messaging service.
   * Should be safe to call even if not connected.
   */
  disconnect(): Promise<void>;

  /**
   * Check if the provider is currently connected.
   */
  isConnected(): boolean;

  // Message sending methods

  /**
   * Send a plan for approval.
   * Resolves when the message is sent, not when approval is received.
   * @param plan - The plan message to send
   * @throws Error if sending fails
   */
  sendPlanForApproval(plan: PlanMessage): Promise<void>;

  /**
   * Send a question to the user.
   * Resolves when the message is sent, not when the answer is received.
   * @param question - The question message to send
   * @throws Error if sending fails
   */
  sendQuestion(question: QuestionMessage): Promise<void>;

  /**
   * Send a status update notification.
   * @param status - The status message to send
   * @throws Error if sending fails
   */
  sendStatus(status: StatusMessage): Promise<void>;

  // Event handlers - set by multiplexer to route responses

  /**
   * Callback invoked when an approval response is received.
   * Set by the multiplexer to route responses.
   */
  onApproval?: (response: ApprovalResponse) => void;

  /**
   * Callback invoked when a question response is received.
   * Set by the multiplexer to route responses.
   */
  onQuestionResponse?: (response: QuestionResponse) => void;
}
