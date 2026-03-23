/**
 * Generic agent provider interface.
 *
 * Abstracts over different AI coding agent CLIs (Claude Code, OpenCode, etc.).
 * The ClaudeWrapper in claude.ts implements this interface; OpenCodeWrapper in
 * opencode.ts is the second implementation.
 */

// =============================================================================
// Shared Types
// =============================================================================

export interface AgentOptions {
  /** Model string — format is provider-specific (e.g. "sonnet", "anthropic/claude-sonnet-4-5") */
  model?: string;
  /** Session ID for resuming a previous session (if supported by the agent) */
  sessionId?: string;
  /** Skip permission prompts */
  skipPermissions?: boolean;
  /** Execution timeout in ms */
  timeout?: number;
  /** Working directory */
  cwd?: string;
  /** Enable verbose output */
  verbose?: boolean;
  /** Max V8 heap size in MB for spawned process (passed via NODE_OPTIONS --max-old-space-size) */
  maxHeapMb?: number;
}

export interface PlanResult {
  success: boolean;
  plan?: string;
  error?: string;
  costUsd?: number;
}

export interface StreamEvent {
  type:
    | "init"
    | "user"
    | "assistant"
    | "result"
    | "tool_use"
    | "tool_result"
    | "error"
    | "system"
    | "rate_limit";
  /** For assistant messages */
  message?: string;
  /** For tool_use */
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** For tool_result */
  toolResult?: unknown;
  /** For result */
  result?: string;
  costUsd?: number;
  sessionId?: string;
  /** For error */
  error?: string;
  /** For rate_limit */
  rateLimitInfo?: {
    status: string;
    resetsAt: number;
    rateLimitType: string;
    overageStatus: string;
    overageDisabledReason?: string;
    isUsingOverage: boolean;
  };
}

export interface ExecutionCallbacks {
  onEvent?: (event: StreamEvent) => void;
  onQuestion?: (question: {
    id: string;
    text: string;
    options?: string[];
  }) => Promise<string>;
  onOutput?: (text: string) => void;
}

export interface ExecutionResult {
  success: boolean;
  error?: string;
  costUsd?: number;
  sessionId?: string;
}

// =============================================================================
// AgentProvider Interface
// =============================================================================

export interface AgentProvider {
  /** The agent identifier, e.g. "claude-code" or "opencode" */
  readonly id: string;

  /**
   * Generate a plan in read-only/plan mode (no file changes allowed).
   * Used by planbot's plan-then-approve flow.
   */
  generatePlan(
    prompt: string,
    options?: AgentOptions,
    onOutput?: (text: string) => void,
  ): Promise<PlanResult>;

  /**
   * Execute a prompt with streaming output.
   * This is the primary execution path for ticket implementation.
   */
  execute(
    prompt: string,
    options: AgentOptions,
    callbacks: ExecutionCallbacks,
  ): Promise<ExecutionResult>;

  /**
   * Resume an existing session with new input.
   * Agents that don't support session resumption should return a new execution.
   */
  resume(
    sessionId: string,
    input: string,
    options: AgentOptions,
    callbacks: ExecutionCallbacks,
  ): Promise<ExecutionResult>;

  /**
   * Send an answer to a pending question (writes to stdin of the running process).
   * Only relevant during an active execute() or resume() call.
   */
  answerQuestion(answer: string): void;

  /** Abort the currently running execution. */
  abort(): void;

  /**
   * Run a standalone one-shot prompt (e.g. for hook evaluation).
   * Runs in an independent process and does not affect the current execution.
   */
  runPrompt(
    prompt: string,
    options?: {
      model?: string;
      cwd?: string;
      timeout?: number;
      skipPermissions?: boolean;
      verbose?: boolean;
      maxHeapMb?: number;
    },
  ): Promise<{
    success: boolean;
    output?: string;
    error?: string;
    costUsd?: number;
  }>;
}
