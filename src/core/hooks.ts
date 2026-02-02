import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../utils/logger.js";
import type { Hook, HookAction, Hooks } from "./schemas.js";

// =============================================================================
// Hook Context Interface
// =============================================================================

export interface HookContext {
  /** Current ticket ID */
  ticketId?: string;
  /** Current ticket title */
  ticketTitle?: string;
  /** Current ticket status */
  ticketStatus?: string;

  /** Path to the generated plan file */
  planPath?: string;
  /** Plan content */
  plan?: string;

  /** Error message (for onError hook) */
  error?: string;

  /** Question text (for onQuestion hook) */
  question?: string;
  /** Question ID (for onQuestion hook) */
  questionId?: string;

  /** Custom metadata - extensible */
  [key: string]: unknown;
}

// =============================================================================
// Hook Result Interface
// =============================================================================

export interface HookResult {
  /** Whether the hook action succeeded */
  success: boolean;
  /** Output from the hook (stdout for shell, prompt for prompt hooks) */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Exit code for shell hooks */
  exitCode?: number;
}

// =============================================================================
// Hook Executor Interface
// =============================================================================

export interface HookExecutor {
  /**
   * Execute a single hook action
   * @param action - The hook action to execute
   * @param context - Context data to inject
   * @returns Promise resolving to hook result
   */
  executeAction(action: HookAction, context: HookContext): Promise<HookResult>;

  /**
   * Execute all actions in a hook array sequentially
   * @param hook - Array of hook actions
   * @param context - Context data to inject
   * @returns Promise resolving to array of results
   */
  executeHook(hook: Hook, context: HookContext): Promise<HookResult[]>;

  /**
   * Execute a named hook from hooks configuration
   * @param hooks - Hooks configuration object
   * @param name - Name of the hook to execute
   * @param context - Context data to inject
   * @returns Promise resolving to array of results
   */
  executeNamed(
    hooks: Hooks | undefined,
    name: keyof Hooks,
    context: HookContext
  ): Promise<HookResult[]>;

  /**
   * Merge ticket-level hooks with global hooks
   * Global hooks execute first, then ticket hooks
   * @param global - Global hooks configuration
   * @param ticket - Ticket-specific hooks (partial)
   * @returns Merged hooks configuration
   */
  mergeHooks(
    global: Hooks | undefined,
    ticket: Partial<Hooks> | undefined
  ): Hooks;
}

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for shell hooks in milliseconds */
const DEFAULT_TIMEOUT_MS = 30000;

// =============================================================================
// Environment Variable Building
// =============================================================================


/**
 * Sanitize environment variable value to remove dangerous control characters.
 * Removes null bytes and control characters except newline and tab.
 * 
 * @param value - The value to sanitize
 * @returns Sanitized value safe for environment variables
 */
function sanitizeEnvValue(value: string): string {
  // Remove null bytes and control characters except newline/tab
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/**
 * Validate ticket ID to prevent path traversal in hooks.
 * Same validation as in state.ts.
 * 
 * @param ticketId - The ticket ID to validate
 * @throws Error if ticket ID contains invalid characters or path traversal patterns
 */
function validateTicketId(ticketId: string): void {
  // Check for path traversal first (more specific error message)
  if (ticketId.includes('..') || ticketId.includes('/') || ticketId.includes('\\')) {
    throw new Error(`Invalid ticket ID: ${ticketId}. Path traversal not allowed.`);
  }
  // Then check for valid characters
  if (!/^[a-zA-Z0-9_-]+$/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}. Only alphanumeric, hyphens, and underscores allowed.`);
  }
}

/**
 * Build environment variables from hook context
 */
function buildEnvVars(
  eventName: string,
  context: HookContext
): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    PLANBOT_EVENT: eventName,
  };

  if (context.ticketId !== undefined) {
    // Validate ticketId before using in env vars
    validateTicketId(context.ticketId);
    env.PLANBOT_TICKET_ID = sanitizeEnvValue(String(context.ticketId));
  }
  if (context.ticketTitle !== undefined) {
    env.PLANBOT_TICKET_TITLE = sanitizeEnvValue(String(context.ticketTitle));
  }
  if (context.ticketStatus !== undefined) {
    env.PLANBOT_TICKET_STATUS = sanitizeEnvValue(String(context.ticketStatus));
  }
  if (context.planPath !== undefined) {
    env.PLANBOT_PLAN_PATH = sanitizeEnvValue(String(context.planPath));
  }
  if (context.plan !== undefined) {
    env.PLANBOT_PLAN = sanitizeEnvValue(String(context.plan));
  }
  if (context.error !== undefined) {
    env.PLANBOT_ERROR = sanitizeEnvValue(String(context.error));
  }
  if (context.question !== undefined) {
    env.PLANBOT_QUESTION = sanitizeEnvValue(String(context.question));
  }
  if (context.questionId !== undefined) {
    env.PLANBOT_QUESTION_ID = sanitizeEnvValue(String(context.questionId));
  }

  return env;
}

// =============================================================================
// Shell Hook Execution
// =============================================================================

/**
 * Execute a shell command with timeout
 */
function executeShellCommand(
  command: string,
  env: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<HookResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let childProcess: ChildProcess | null = null;

    const timeout = setTimeout(() => {
      killed = true;
      if (childProcess) {
        childProcess.kill("SIGTERM");
        // Force kill after grace period
        setTimeout(() => {
          if (childProcess && !childProcess.killed) {
            childProcess.kill("SIGKILL");
          }
        }, 5000);
      }
    }, timeoutMs);

    try {
      childProcess = spawn("sh", ["-c", command], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      childProcess.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on("close", (code) => {
        clearTimeout(timeout);

        if (killed) {
          resolve({
            success: false,
            error: `Command timed out after ${timeoutMs}ms`,
            output: stdout,
            exitCode: -1,
          });
          return;
        }

        const exitCode = code ?? 0;
        resolve({
          success: exitCode === 0,
          output: stdout,
          error: exitCode !== 0 ? stderr || `Exit code: ${exitCode}` : undefined,
          exitCode,
        });
      });

      childProcess.on("error", (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: `Spawn error: ${err.message}`,
          exitCode: -1,
        });
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve({
        success: false,
        error: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: -1,
      });
    }
  });
}

// =============================================================================
// Hook Executor Implementation
// =============================================================================

/**
 * Create a hook executor instance
 */
function createHookExecutor(): HookExecutor {
  return {
    async executeAction(
      action: HookAction,
      context: HookContext
    ): Promise<HookResult> {
      if (action.type === "shell") {
        logger.debug("Executing shell hook", { command: action.command });

        const env = buildEnvVars("hook", context);
        const result = await executeShellCommand(action.command, env);

        if (result.success) {
          logger.debug("Shell hook completed", { exitCode: result.exitCode });
        } else {
          logger.warn("Shell hook failed", {
            command: action.command,
            error: result.error,
            exitCode: result.exitCode,
          });
        }

        return result;
      }

      // action.type === "prompt"
      // Prompt hooks are not executable - they are hints for the AI
      // Return success with the prompt as output for the orchestrator
      logger.debug("Returning prompt hook for AI injection", {
        promptLength: action.prompt.length,
      });

      return {
        success: true,
        output: action.prompt,
      };
    },

    async executeHook(hook: Hook, context: HookContext): Promise<HookResult[]> {
      const results: HookResult[] = [];

      for (const action of hook) {
        const result = await this.executeAction(action, context);
        results.push(result);

        // Stop on first failure
        if (!result.success) {
          logger.debug("Hook execution stopped due to failure", {
            failedAt: results.length,
            total: hook.length,
          });
          break;
        }
      }

      return results;
    },

    async executeNamed(
      hooks: Hooks | undefined,
      name: keyof Hooks,
      context: HookContext
    ): Promise<HookResult[]> {
      if (!hooks) {
        return [];
      }

      const hook = hooks[name];
      if (!hook || hook.length === 0) {
        return [];
      }

      logger.info(`Executing ${String(name)} hook`, { actionCount: hook.length });

      // Inject the event name into environment
      const contextWithEvent = { ...context };

      // Build environment with proper event name
      const results = await this.executeHook(hook, contextWithEvent);

      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        logger.warn(`${String(name)} hook had failures`, {
          total: results.length,
          failed: failed.length,
        });
      } else {
        logger.debug(`${String(name)} hook completed`, { total: results.length });
      }

      return results;
    },

    mergeHooks(
      global: Hooks | undefined,
      ticket: Partial<Hooks> | undefined
    ): Hooks {
      const hookNames: (keyof Hooks)[] = [
        "beforeAll",
        "afterAll",
        "beforeEach",
        "afterEach",
        "onError",
        "onQuestion",
        "onPlanGenerated",
        "onApproval",
        "onComplete",
      ];

      const merged: Hooks = {};

      for (const name of hookNames) {
        const globalHook = global?.[name] ?? [];
        const ticketHook = ticket?.[name] ?? [];

        // Concatenate: global first, then ticket
        const combined = [...globalHook, ...ticketHook];

        if (combined.length > 0) {
          merged[name] = combined;
        }
      }

      return merged;
    },
  };
}

// =============================================================================
// Exported Instance
// =============================================================================

/**
 * Default hook executor instance
 */
export const hookExecutor: HookExecutor = createHookExecutor();
