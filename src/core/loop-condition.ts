import { spawn } from "node:child_process";
import { logger } from "../utils/logger.js";
import type { LoopCondition } from "./schemas.js";

// =============================================================================
// Types
// =============================================================================

export interface ConditionResult {
  /** Whether the completion condition was met */
  met: boolean;
  /** Output from the condition evaluation */
  output?: string;
  /** Error message if evaluation failed */
  error?: string;
}

export interface ConditionEvaluatorOptions {
  /** Whether shell hooks are permitted */
  allowShellHooks: boolean;
  /** Runner for prompt-based conditions — sends prompt to Claude and returns response */
  claudeRunner?: (prompt: string) => Promise<{ success: boolean; output?: string; error?: string }>;
  /** Working directory for shell commands */
  cwd?: string;
  /** Timeout for shell commands in milliseconds (default: 30000) */
  timeout?: number;
}

export interface ConditionContext {
  ticketId: string;
  iteration: number;
  goal: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Allowlist of system environment variables passed to condition shell subprocesses.
 */
const ALLOWED_SYSTEM_VARS = ['PATH', 'HOME', 'SHELL', 'TERM', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;

// =============================================================================
// Shell Condition Evaluation
// =============================================================================

function evaluateShellCondition(
  command: string,
  options: ConditionEvaluatorOptions
): Promise<ConditionResult> {
  if (!options.allowShellHooks) {
    return Promise.resolve({
      met: false,
      error: "Shell conditions are disabled. Set allowShellHooks: true in config.",
    });
  }

  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    // Build minimal environment
    const env: Record<string, string> = {};
    for (const key of ALLOWED_SYSTEM_VARS) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }

    const timer = setTimeout(() => {
      killed = true;
      childProcess.kill("SIGTERM");
      setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    let childProcess: ReturnType<typeof spawn>;

    try {
      childProcess = spawn("sh", ["-c", command], {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({
        met: false,
        error: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    childProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    childProcess.on("close", (code) => {
      clearTimeout(timer);

      if (killed) {
        resolve({
          met: false,
          output: stdout,
          error: `Command timed out after ${timeoutMs}ms`,
        });
        return;
      }

      const exitCode = code ?? 0;
      resolve({
        met: exitCode === 0,
        output: stdout.trim(),
        error: exitCode !== 0 ? (stderr.trim() || `Exit code: ${exitCode}`) : undefined,
      });
    });

    childProcess.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        met: false,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}

// =============================================================================
// Prompt Condition Evaluation
// =============================================================================

async function evaluatePromptCondition(
  command: string,
  context: ConditionContext,
  options: ConditionEvaluatorOptions
): Promise<ConditionResult> {
  if (!options.claudeRunner) {
    return {
      met: false,
      error: "Prompt conditions require a claudeRunner but none was provided.",
    };
  }

  const evaluationPrompt = [
    `# Loop Condition Evaluation`,
    ``,
    `## Goal`,
    context.goal,
    ``,
    `## Iteration`,
    `${context.iteration + 1} (0-indexed: ${context.iteration})`,
    ``,
    `## Condition to Evaluate`,
    command,
    ``,
    `## Instructions`,
    `Evaluate whether the condition above has been met.`,
    `Respond with EXACTLY one of these on the first line:`,
    `- "YES" if the condition is met`,
    `- "NO" if the condition is not met`,
    ``,
    `Then optionally provide a brief explanation on subsequent lines.`,
  ].join("\n");

  const result = await options.claudeRunner(evaluationPrompt);

  if (!result.success) {
    return {
      met: false,
      output: result.output,
      error: result.error ?? "Prompt condition evaluation failed",
    };
  }

  const output = result.output ?? "";
  const firstLine = output.split("\n")[0]?.trim().toLowerCase() ?? "";

  const met = firstLine === "yes" || firstLine === "true" || firstLine === "met";

  return {
    met,
    output,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Evaluate a loop completion condition.
 *
 * @param condition - The condition to evaluate (shell or prompt)
 * @param context - Context about the current loop iteration
 * @param options - Evaluation options (shell permissions, claude runner, cwd, timeout)
 * @returns Whether the condition was met, with optional output/error
 */
export async function evaluateCondition(
  condition: LoopCondition,
  context: ConditionContext,
  options: ConditionEvaluatorOptions
): Promise<ConditionResult> {
  logger.debug("Evaluating loop condition", {
    type: condition.type,
    ticketId: context.ticketId,
    iteration: context.iteration,
  });

  let result: ConditionResult;

  switch (condition.type) {
    case "shell":
      result = await evaluateShellCondition(condition.command, options);
      break;
    case "prompt":
      result = await evaluatePromptCondition(condition.command, context, options);
      break;
    default:
      result = { met: false, error: `Unknown condition type: ${(condition as { type: string }).type}` };
  }

  logger.debug("Condition evaluation result", {
    type: condition.type,
    met: result.met,
    hasError: !!result.error,
  });

  return result;
}
