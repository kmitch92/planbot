import { z } from "zod";

// =============================================================================
// Environment Variable Substitution Pattern
// =============================================================================

/**
 * Regex pattern for environment variable substitution: ${VAR_NAME}
 */
const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Schema for strings that may contain environment variable references.
 * Validates the syntax but doesn't resolve values at parse time.
 */
const envSubstitutableString = z.string().refine(
  (val) => {
    // Check that all ${...} patterns contain valid env var names
    const matches = val.matchAll(/\$\{([^}]*)\}/g);
    for (const match of matches) {
      const varName = match[1];
      if (!/^[A-Z_][A-Z0-9_]*$/.test(varName ?? "")) {
        return false;
      }
    }
    return true;
  },
  {
    message:
      "Invalid environment variable syntax. Use ${VAR_NAME} with uppercase letters, numbers, and underscores.",
  }
);

// =============================================================================
// Messaging Provider Configurations
// =============================================================================

export const SlackConfigSchema = z.object({
  provider: z.literal("slack"),
  botToken: envSubstitutableString,
  appToken: envSubstitutableString,
  channel: z.string().min(1),
});

export const DiscordConfigSchema = z.object({
  provider: z.literal("discord"),
  botToken: envSubstitutableString,
  channelId: z.string().min(1),
});

export const TelegramConfigSchema = z.object({
  provider: z.literal("telegram"),
  botToken: envSubstitutableString,
  chatId: z.string().min(1),
});

export const MessagingConfigSchema = z.discriminatedUnion("provider", [
  SlackConfigSchema,
  DiscordConfigSchema,
  TelegramConfigSchema,
]);

// =============================================================================
// Webhook Configuration
// =============================================================================

export const WebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().positive().default(3847),
  path: z.string().startsWith("/").default("/planbot/webhook"),
  secret: z.string().min(1).optional(),
  cors: z.boolean().default(false),
  corsOrigins: z.array(z.string().url()).optional(),
  insecure: z.boolean().default(false),
});

// =============================================================================
// Timeouts Configuration
// =============================================================================

export const TimeoutsSchema = z.object({
  /** Plan generation timeout in milliseconds (default: 15 minutes) */
  planGeneration: z.number().int().positive().default(900000),
  /** Execution timeout in milliseconds (default: 30 minutes) */
  execution: z.number().int().positive().default(1800000),
  /** Approval timeout in milliseconds (default: 24 hours) */
  approval: z.number().int().positive().default(86400000),
  /** Question timeout in milliseconds (default: 1 hour) */
  question: z.number().int().positive().default(3600000),
});

// =============================================================================
// Hook System
// =============================================================================

export const ShellHookActionSchema = z.object({
  type: z.literal("shell"),
  command: z.string().min(1).max(10000),
});

export const PromptHookActionSchema = z.object({
  type: z.literal("prompt"),
  command: z.string().min(1).max(50000),
});

export const HookActionSchema = z.discriminatedUnion("type", [
  ShellHookActionSchema,
  PromptHookActionSchema,
]);

export const HookSchema = z.array(HookActionSchema);

export const HooksSchema = z.object({
  /** Runs once before processing any tickets */
  beforeAll: HookSchema.optional(),
  /** Runs once after all tickets are processed */
  afterAll: HookSchema.optional(),
  /** Runs before each ticket starts processing */
  beforeEach: HookSchema.optional(),
  /** Runs after each ticket completes (success or failure) */
  afterEach: HookSchema.optional(),
  /** Runs when an error occurs during ticket processing */
  onError: HookSchema.optional(),
  /** Runs when Claude asks a question requiring user input */
  onQuestion: HookSchema.optional(),
  /** Runs after a plan is generated but before approval */
  onPlanGenerated: HookSchema.optional(),
  /** Runs when a ticket requires approval */
  onApproval: HookSchema.optional(),
  /** Runs when a ticket completes successfully */
  onComplete: HookSchema.optional(),
});

// =============================================================================
// Top-Level Configuration
// =============================================================================

export const ModelSchema = z.enum(["sonnet", "opus", "haiku"]);

export const ConfigSchema = z.object({
  /** Claude model override — omit to use your Claude CLI default */
  model: ModelSchema.optional(),
  /** Maximum budget in dollars per ticket */
  maxBudgetPerTicket: z.number().positive().default(10),
  /** Maximum retry attempts for failed operations */
  maxRetries: z.number().int().nonnegative().default(3),
  /** Continue processing queue if a ticket fails */
  continueOnError: z.boolean().default(false),
  /** Automatically approve plans without human review */
  autoApprove: z.boolean().default(false),
  /** Whether to generate a plan before execution (default: true). When false, tickets execute directly from their description. */
  planMode: z.boolean().default(true),
  /** Skip permission prompts (dangerous mode) */
  skipPermissions: z.boolean().default(false),
  /** Enable shell hook execution (default: false for security) */
  allowShellHooks: z.boolean().default(false),
  /** Messaging provider configuration */
  messaging: MessagingConfigSchema.optional(),
  /** Webhook server configuration */
  webhook: WebhookConfigSchema.default({}),
  /** Timeout configurations */
  timeouts: TimeoutsSchema.default({}),
});

// =============================================================================
// Ticket System
// =============================================================================

export const TicketStatusSchema = z.enum([
  "pending",
  "planning",
  "awaiting_approval",
  "approved",
  "executing",
  "completed",
  "failed",
  "skipped",
]);

export const TicketSchema = z.object({
  /** Unique ticket identifier */
  id: z.string().min(1).max(100),
  /** Short descriptive title */
  title: z.string().min(1).max(200),
  /** Detailed description of the work to be done */
  description: z.string().min(1).max(50000),
  /** Priority level (higher = more urgent, default: 0) */
  priority: z.number().int().default(0),
  /** Current ticket status */
  status: TicketStatusSchema.default("pending"),
  /** List of acceptance criteria for completion */
  acceptanceCriteria: z.array(z.string()).optional(),
  /** IDs of tickets that must complete before this one */
  dependencies: z.array(z.string()).optional(),
  /** Ticket-specific hook overrides */
  hooks: HooksSchema.partial().optional(),
  /** Arbitrary metadata for extensibility */
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Override global planMode for this ticket. When false, skips plan generation and executes directly. */
  planMode: z.boolean().optional(),
  /** Whether the ticket has been completed (persisted to YAML for restart resilience) */
  complete: z.boolean().default(false),
});

// =============================================================================
// Tickets File (Root Schema)
// =============================================================================

export const TicketsFileSchema = z.object({
  /** Global configuration */
  config: ConfigSchema.default({}),
  /** Global hooks */
  hooks: HooksSchema.optional(),
  /** Ticket queue */
  tickets: z.array(TicketSchema),
});

// =============================================================================
// State Management
// =============================================================================

export const PhaseSchema = z.enum([
  "idle",
  "planning",
  "awaiting_approval",
  "executing",
]);

export const PendingQuestionSchema = z.object({
  id: z.string().min(1).max(100),
  ticketId: z.string().min(1),
  question: z.string().min(1),
  askedAt: z.string().datetime(),
});

export const StateSchema = z.object({
  /** State file format version */
  version: z.string().min(1),
  /** ID of ticket currently being processed */
  currentTicketId: z.string().nullable(),
  /** Current processing phase */
  currentPhase: PhaseSchema.default("idle"),
  /** Claude session ID for conversation continuity */
  sessionId: z.string().nullable(),
  /** Flag indicating pause was requested */
  pauseRequested: z.boolean().default(false),
  /** ISO timestamp when processing started */
  startedAt: z.string().datetime(),
  /** ISO timestamp of last state update */
  lastUpdatedAt: z.string().datetime(),
  /** Questions awaiting user response */
  pendingQuestions: z.array(PendingQuestionSchema).default([]),
});

// =============================================================================
// Question Schema (Extended)
// =============================================================================

export const QuestionOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

export const QuestionSchema = z.object({
  /** Unique question identifier */
  id: z.string().min(1).max(100),
  /** ID of ticket that generated the question */
  ticketId: z.string().min(1),
  /** The question text */
  question: z.string().min(1),
  /** Optional predefined answer options */
  options: z.array(QuestionOptionSchema).optional(),
  /** ISO timestamp when question was asked */
  askedAt: z.string().datetime(),
  /** ISO timestamp when question was answered */
  answeredAt: z.string().datetime().nullable(),
  /** User's answer */
  answer: z.string().nullable(),
});

// =============================================================================
// Derived TypeScript Types
// =============================================================================

export type SlackConfig = z.infer<typeof SlackConfigSchema>;
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type MessagingConfig = z.infer<typeof MessagingConfigSchema>;

export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type Timeouts = z.infer<typeof TimeoutsSchema>;

export type ShellHookAction = z.infer<typeof ShellHookActionSchema>;
export type PromptHookAction = z.infer<typeof PromptHookActionSchema>;
export type HookAction = z.infer<typeof HookActionSchema>;
export type Hook = z.infer<typeof HookSchema>;
export type Hooks = z.infer<typeof HooksSchema>;

export type Model = z.infer<typeof ModelSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export type TicketStatus = z.infer<typeof TicketStatusSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type TicketsFile = z.infer<typeof TicketsFileSchema>;

export type Phase = z.infer<typeof PhaseSchema>;
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;
export type State = z.infer<typeof StateSchema>;

export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type Question = z.infer<typeof QuestionSchema>;

// =============================================================================
// Input Types (for creating new instances without defaults applied)
// =============================================================================

export type TicketInput = z.input<typeof TicketSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type TicketsFileInput = z.input<typeof TicketsFileSchema>;
export type StateInput = z.input<typeof StateSchema>;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse and validate a tickets file (YAML or JSON content as string).
 * Expects the content to already be parsed into an object (use yaml.parse or JSON.parse first).
 *
 * @param content - Parsed content object from YAML or JSON
 * @returns Validated TicketsFile with defaults applied
 * @throws ZodError if validation fails
 */
export function parseTicketsFile(content: unknown): TicketsFile {
  return TicketsFileSchema.parse(content);
}

/**
 * Safely parse a tickets file, returning a result object.
 *
 * @param content - Parsed content object from YAML or JSON
 * @returns SafeParseResult with success flag and data or error
 */
export function safeParseTicketsFile(
  content: unknown
): z.SafeParseReturnType<z.input<typeof TicketsFileSchema>, TicketsFile> {
  return TicketsFileSchema.safeParse(content);
}

/**
 * Parse and validate a state file.
 *
 * @param content - Parsed content object from JSON
 * @returns Validated State with defaults applied
 * @throws ZodError if validation fails
 */
export function parseStateFile(content: unknown): State {
  return StateSchema.parse(content);
}

/**
 * Safely parse a state file, returning a result object.
 *
 * @param content - Parsed content object from JSON
 * @returns SafeParseResult with success flag and data or error
 */
export function safeParseStateFile(
  content: unknown
): z.SafeParseReturnType<z.input<typeof StateSchema>, State> {
  return StateSchema.safeParse(content);
}

/**
 * Resolve environment variable substitutions in a string.
 *
 * @param value - String potentially containing ${VAR_NAME} patterns
 * @returns String with environment variables resolved
 * @throws Error if referenced environment variable is not set
 */
export function resolveEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return envValue;
  });
}

/**
 * Resolve environment variables in a messaging config.
 *
 * @param config - Messaging configuration with potential env var references
 * @returns Configuration with environment variables resolved
 */
export function resolveMessagingConfig<T extends MessagingConfig>(
  config: T
): T {
  const resolved = { ...config };

  switch (resolved.provider) {
    case "slack":
      resolved.botToken = resolveEnvVars(resolved.botToken);
      resolved.appToken = resolveEnvVars(resolved.appToken);
      break;
    case "discord":
      resolved.botToken = resolveEnvVars(resolved.botToken);
      break;
    case "telegram":
      resolved.botToken = resolveEnvVars(resolved.botToken);
      break;
  }

  return resolved;
}

/**
 * Create a default state object.
 *
 * @returns Fresh state object with sensible defaults
 */
export function createDefaultState(): State {
  const now = new Date().toISOString();
  return {
    version: "1.0.0",
    currentTicketId: null,
    currentPhase: "idle",
    sessionId: null,
    pauseRequested: false,
    startedAt: now,
    lastUpdatedAt: now,
    pendingQuestions: [],
  };
}

/**
 * Validate that ticket dependencies exist and are acyclic.
 *
 * @param tickets - Array of tickets to validate
 * @returns Object with valid flag and optional error messages
 */
export function validateTicketDependencies(tickets: Ticket[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const ticketIds = new Set(tickets.map((t) => t.id));

  // Check for missing dependencies
  for (const ticket of tickets) {
    if (ticket.dependencies) {
      for (const depId of ticket.dependencies) {
        if (!ticketIds.has(depId)) {
          errors.push(
            `Ticket "${ticket.id}" depends on non-existent ticket "${depId}"`
          );
        }
      }
    }
  }

  // Check for circular dependencies using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(ticketId: string): boolean {
    visited.add(ticketId);
    recursionStack.add(ticketId);

    const ticket = tickets.find((t) => t.id === ticketId);
    if (ticket?.dependencies) {
      for (const depId of ticket.dependencies) {
        if (!visited.has(depId)) {
          if (hasCycle(depId)) {
            return true;
          }
        } else if (recursionStack.has(depId)) {
          errors.push(`Circular dependency detected involving ticket "${ticketId}"`);
          return true;
        }
      }
    }

    recursionStack.delete(ticketId);
    return false;
  }

  for (const ticket of tickets) {
    if (!visited.has(ticket.id)) {
      hasCycle(ticket.id);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
