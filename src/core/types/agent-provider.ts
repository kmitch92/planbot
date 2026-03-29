/** Provider-agnostic options for agent execution. */
export interface ProviderOptions {
  model?: string;
  sessionId?: string;
  skipPermissions?: boolean;
  timeout?: number;
  cwd?: string;
  verbose?: boolean;
}

/** Result of a plan generation request. */
export interface PlanResult {
  success: boolean;
  plan?: string;
  error?: string;
  costUsd?: number;
}

/** A streaming event emitted during agent execution. */
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
  message?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  result?: string;
  costUsd?: number;
  sessionId?: string;
  error?: string;
  rateLimitInfo?: {
    status: string;
    resetsAt: number;
    rateLimitType: string;
    overageStatus: string;
    overageDisabledReason?: string;
    isUsingOverage: boolean;
  };
}

/** Callbacks for streaming execution events. */
export interface ExecutionCallbacks {
  onEvent?: (event: StreamEvent) => void;
  onQuestion?: (question: {
    id: string;
    text: string;
    options?: string[];
  }) => Promise<string>;
  onOutput?: (text: string) => void;
}

/** Result of an agent execution or resume operation. */
export interface ExecutionResult {
  success: boolean;
  error?: string;
  costUsd?: number;
  sessionId?: string;
}

/** Result of a single prompt invocation. */
export interface PromptResult {
  success: boolean;
  output?: string;
  error?: string;
  costUsd?: number;
}

/** Static metadata describing an agent provider. */
export interface AgentProviderMetadata {
  name: string;
  supportedModels: readonly string[];
}

/** Provider-agnostic interface for AI agent interactions. */
export interface AgentProvider {
  /** Static metadata about this provider. */
  readonly metadata: AgentProviderMetadata;

  /** Generate a plan from a prompt. */
  generatePlan(
    prompt: string,
    options?: ProviderOptions,
    onOutput?: (text: string) => void,
  ): Promise<PlanResult>;

  /** Execute a prompt with streaming callbacks. */
  execute(
    prompt: string,
    options: ProviderOptions,
    callbacks: ExecutionCallbacks,
  ): Promise<ExecutionResult>;

  /** Resume an existing session with new input. */
  resume(
    sessionId: string,
    input: string,
    options: ProviderOptions,
    callbacks: ExecutionCallbacks,
  ): Promise<ExecutionResult>;

  /** Provide an answer to a pending question. */
  answerQuestion(answer: string): void;

  /** Abort the current operation. */
  abort(): void;

  /** Run a one-shot prompt and return the result. */
  runPrompt(
    prompt: string,
    options?: Omit<ProviderOptions, 'sessionId'>,
  ): Promise<PromptResult>;

  /** Get the timestamp when the current rate limit resets, or null if not rate-limited. */
  getRateLimitResetsAt(): number | null;

  /** Clear any stored rate limit reset timestamp. */
  clearRateLimitResetsAt(): void;
}
