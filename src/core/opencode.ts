import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import {
  killWithTimeout,
  processRegistry,
} from "../utils/process-lifecycle.js";
import { appendBounded, MAX_STDERR_CHARS } from "./claude.js";
import type {
  AgentProvider,
  AgentOptions,
  PlanResult,
  StreamEvent,
  ExecutionCallbacks,
  ExecutionResult,
} from "./agent-provider.js";

// =============================================================================
// OpenCode JSON event types (from `opencode run --format json`)
// =============================================================================

interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  // step-start / step-finish fields
  snapshot?: string;
  reason?: string;
  cost?: number;
  tokens?: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  // text fields
  text?: string;
  time?: { start: number; end: number };
  // tool fields
  callID?: string;
  tool?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    error?: string;
  };
}

interface OpenCodeEvent {
  type: "step_start" | "step_finish" | "text" | "tool_use" | "error" | string;
  timestamp: number;
  sessionID: string;
  part: OpenCodePart;
}

// =============================================================================
// OpenCodeWrapperImpl
// =============================================================================

class OpenCodeWrapperImpl implements AgentProvider {
  readonly id = "opencode";
  private currentProcess: ChildProcess | null = null;

  /**
   * Generate a plan using OpenCode's experimental plan mode.
   * If OPENCODE_EXPERIMENTAL_PLAN_MODE is not available, falls back to a
   * "plan only, no changes" prompt prefix to constrain the model.
   */
  async generatePlan(
    prompt: string,
    options: AgentOptions = {},
    onOutput?: (text: string) => void,
  ): Promise<PlanResult> {
    const { model, timeout = 900000, cwd, verbose, skipPermissions } = options;

    logger.info("Generating plan with OpenCode", { model, timeout });

    return new Promise((resolve) => {
      const args = ["run", "--format", "json"];
      if (model) args.push("--model", model);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCODE_EXPERIMENTAL_PLAN_MODE: "true",
      };
      if (skipPermissions) {
        env.OPENCODE_PERMISSION = JSON.stringify("allow");
      }

      const proc = spawn("opencode", args, {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      processRegistry.register(proc, "opencode-plan");

      let logStream: ReturnType<typeof createWriteStream> | null = null;
      if (verbose && cwd) {
        const logDir = join(cwd, ".planbot", "logs");
        mkdirSync(logDir, { recursive: true });
        const logPath = join(logDir, `plan-opencode-${Date.now()}.log`);
        logStream = createWriteStream(logPath, { flags: "w" });
        logStream.write(
          `=== OpenCode plan started at ${new Date().toISOString()} ===\n`,
        );
        logger.info("OpenCode plan log", { path: logPath });
      }

      const textParts: string[] = [];
      let finalSessionId: string | undefined;
      let errorMessage: string | undefined;
      let timedOut = false;
      let lineBuffer = "";
      let stderrOutput = "";

      const timer = setTimeout(() => {
        timedOut = true;
        killWithTimeout(proc);
        logger.warn("OpenCode plan generation timed out", { timeout });
      }, timeout);

      proc.stdout?.on("data", (chunk: Buffer) => {
        const data = chunk.toString();
        logStream?.write(data);
        onOutput?.(data);

        lineBuffer += data;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as OpenCodeEvent;
            finalSessionId = event.sessionID;

            if (event.type === "text" && event.part.text) {
              textParts.push(event.part.text);
            } else if (event.type === "error" && event.part.state?.error) {
              errorMessage = event.part.state.error;
            } else if (
              event.type === "step_finish" &&
              event.part.reason === "error"
            ) {
              errorMessage ??= "OpenCode step finished with error";
            }
          } catch {
            // Not valid JSON
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        logStream?.write(`[STDERR] ${text}`);
        stderrOutput = appendBounded(stderrOutput, text, MAX_STDERR_CHARS);
        onOutput?.(text);
        logger.warn("OpenCode stderr (plan)", {
          text: text.trim().slice(0, 500),
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        logStream?.end();
        logger.error("Failed to spawn opencode process", {
          error: err.message,
        });
        resolve({
          success: false,
          error: `Failed to spawn opencode: ${err.message}`,
        });
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        logStream?.end();

        // Process remaining buffer
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer) as OpenCodeEvent;
            finalSessionId ??= event.sessionID;
            if (event.type === "text" && event.part.text) {
              textParts.push(event.part.text);
            }
          } catch {
            /* not JSON */
          }
        }

        logger.info("OpenCode plan process exited", {
          code,
          textParts: textParts.length,
          sessionId: finalSessionId,
        });

        if (timedOut) {
          resolve({ success: false, error: "Plan generation timed out" });
          return;
        }

        if (errorMessage) {
          resolve({ success: false, error: errorMessage });
          return;
        }

        if (code !== 0 && textParts.length === 0) {
          resolve({
            success: false,
            error: stderrOutput.trim() || `opencode exited with code ${code}`,
          });
          return;
        }

        const plan = textParts.join("").trim();
        resolve({ success: true, plan: plan || undefined });
      });

      // Send prompt via stdin (same nd-JSON format as opencode run reads)
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  }

  /**
   * Execute a prompt, streaming events back via callbacks.
   */
  async execute(
    prompt: string,
    options: AgentOptions,
    callbacks: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const {
      model,
      sessionId,
      skipPermissions,
      timeout = 1800000,
      cwd,
      verbose,
    } = options;
    logger.debug("Executing with OpenCode", {
      model,
      sessionId,
      skipPermissions,
    });
    return this.runStreamingProcess(
      prompt,
      { model, sessionId, skipPermissions, timeout, cwd, verbose },
      callbacks,
    );
  }

  /**
   * Resume an existing session.
   */
  async resume(
    sessionId: string,
    input: string,
    options: AgentOptions,
    callbacks: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const { model, skipPermissions, timeout = 1800000, cwd, verbose } = options;
    logger.debug("Resuming OpenCode session", { sessionId, model });
    return this.runStreamingProcess(
      input,
      {
        model,
        sessionId,
        skipPermissions,
        timeout,
        cwd,
        verbose,
      },
      callbacks,
    );
  }

  /**
   * Send answer to stdin of the running process.
   * OpenCode's `opencode run` doesn't support interactive stdin after start,
   * so this is a no-op with a warning. Questions are handled via the --format
   * json event stream for permission requests.
   */
  answerQuestion(_answer: string): void {
    logger.warn(
      "OpenCode does not support interactive question answering via stdin. Use the HTTP API or permission configuration instead.",
    );
  }

  /**
   * Abort the current execution.
   */
  abort(): void {
    if (!this.currentProcess) {
      logger.debug("No active OpenCode process to abort");
      return;
    }
    logger.info("Aborting OpenCode execution");
    killWithTimeout(this.currentProcess);
  }

  /**
   * Run a standalone one-shot prompt (e.g. for hook evaluation).
   */
  async runPrompt(
    prompt: string,
    options: {
      model?: string;
      cwd?: string;
      timeout?: number;
      skipPermissions?: boolean;
      verbose?: boolean;
    } = {},
  ): Promise<{
    success: boolean;
    output?: string;
    error?: string;
    costUsd?: number;
  }> {
    const { model, cwd, timeout = 300000, skipPermissions } = options;

    logger.info("Running standalone OpenCode prompt", {
      promptPreview: prompt.slice(0, 200),
      model,
    });

    return new Promise((resolve) => {
      const args = ["run", "--format", "json", prompt];
      if (model) args.push("--model", model);

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (skipPermissions) {
        env.OPENCODE_PERMISSION = JSON.stringify("allow");
      }

      const proc = spawn("opencode", args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      processRegistry.register(proc, "opencode-prompt");

      const textParts: string[] = [];
      let errorMessage: string | undefined;
      let timedOut = false;
      let lineBuffer = "";
      let stderrOutput = "";

      const timer = setTimeout(() => {
        timedOut = true;
        killWithTimeout(proc);
      }, timeout);

      proc.stdout?.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as OpenCodeEvent;
            if (event.type === "text" && event.part.text) {
              textParts.push(event.part.text);
            } else if (event.type === "error" && event.part.state?.error) {
              errorMessage = event.part.state.error;
            }
          } catch {
            /* not JSON */
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrOutput = appendBounded(
          stderrOutput,
          chunk.toString(),
          MAX_STDERR_CHARS,
        );
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: `Failed to spawn opencode: ${err.message}`,
        });
      });

      proc.on("close", (code) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({ success: false, error: "OpenCode prompt timed out" });
          return;
        }
        if (errorMessage) {
          resolve({ success: false, error: errorMessage });
          return;
        }
        if (code !== 0 && textParts.length === 0) {
          resolve({
            success: false,
            error: stderrOutput.trim() || `opencode exited with code ${code}`,
          });
          return;
        }

        resolve({ success: true, output: textParts.join("").trim() });
      });
    });
  }

  // =============================================================================
  // Private helpers
  // =============================================================================

  private runStreamingProcess(
    prompt: string,
    options: {
      model?: string;
      sessionId?: string;
      timeout: number;
      cwd?: string;
      verbose?: boolean;
      skipPermissions?: boolean;
    },
    callbacks: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const { model, sessionId, timeout, cwd, verbose, skipPermissions } =
      options;

    return new Promise((resolve) => {
      const args = ["run", "--format", "json"];
      if (model) args.push("--model", model);
      if (sessionId) args.push("--session", sessionId);

      // Append the prompt as a positional argument
      args.push(prompt);

      // When skipPermissions is set, grant all tool permissions automatically
      // via the OPENCODE_PERMISSION env var (equivalent to "permission": "allow" in config)
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (skipPermissions) {
        env.OPENCODE_PERMISSION = JSON.stringify("allow");
      }

      const proc = spawn("opencode", args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      processRegistry.register(proc, "opencode-execute");
      this.currentProcess = proc;

      let logStream: ReturnType<typeof createWriteStream> | null = null;
      if (verbose && cwd) {
        const logDir = join(cwd, ".planbot", "logs");
        mkdirSync(logDir, { recursive: true });
        const logPath = join(logDir, `exec-opencode-${Date.now()}.log`);
        logStream = createWriteStream(logPath, { flags: "w" });
        logStream.write(
          `=== OpenCode execution started at ${new Date().toISOString()} ===\n`,
        );
        logStream.write(`=== Args: ${args.join(" ")} ===\n\n`);
      }

      let finalSessionId: string | undefined = sessionId;
      let errorMessage: string | undefined;
      let timedOut = false;
      let lineBuffer = "";
      let stderrOutput = "";

      const timer = setTimeout(() => {
        timedOut = true;
        killWithTimeout(proc);
        logger.warn("OpenCode execution timed out", { timeout });
      }, timeout);

      proc.stdout?.on("data", (chunk: Buffer) => {
        const data = chunk.toString();
        logStream?.write(data);
        callbacks.onOutput?.(data);

        lineBuffer += data;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as OpenCodeEvent;
            finalSessionId = event.sessionID;
            this.dispatchEvent(event, callbacks);
          } catch {
            // Not valid JSON
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        logStream?.write(`[STDERR] ${text}`);
        stderrOutput = appendBounded(stderrOutput, text, MAX_STDERR_CHARS);
        callbacks.onOutput?.(text);
        logger.warn("OpenCode stderr", { text: text.trim().slice(0, 500) });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        logStream?.end();
        this.currentProcess = null;
        logger.error("Failed to spawn opencode process", {
          error: err.message,
        });
        resolve({
          success: false,
          error: `Failed to spawn opencode: ${err.message}`,
        });
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        logStream?.end();
        this.currentProcess = null;

        // Process remaining buffer
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer) as OpenCodeEvent;
            finalSessionId ??= event.sessionID;
            this.dispatchEvent(event, callbacks);
          } catch {
            /* not JSON */
          }
        }

        logger.info("OpenCode process exited", {
          code,
          sessionId: finalSessionId,
        });

        if (timedOut) {
          resolve({
            success: false,
            error: "OpenCode execution timed out",
            sessionId: finalSessionId,
          });
          return;
        }

        if (errorMessage) {
          resolve({
            success: false,
            error: errorMessage,
            sessionId: finalSessionId,
          });
          return;
        }

        if (code !== 0) {
          resolve({
            success: false,
            error: stderrOutput.trim() || `opencode exited with code ${code}`,
            sessionId: finalSessionId,
          });
          return;
        }

        resolve({ success: true, sessionId: finalSessionId });
      });
    });
  }

  /**
   * Translate an OpenCode nd-JSON event into a planbot StreamEvent and dispatch it.
   */
  private dispatchEvent(
    event: OpenCodeEvent,
    callbacks: ExecutionCallbacks,
  ): void {
    const { onEvent } = callbacks;
    if (!onEvent) return;

    switch (event.type) {
      case "text": {
        if (event.part.text) {
          onEvent({
            type: "assistant",
            message: event.part.text,
            sessionId: event.sessionID,
          });
        }
        break;
      }

      case "tool_use": {
        const state = event.part.state;
        const toolName = event.part.tool ?? "unknown";

        if (state?.status === "completed" || state?.status === "running") {
          onEvent({
            type: "tool_use",
            toolName,
            toolInput: state.input,
            sessionId: event.sessionID,
          });
        }
        if (state?.status === "completed" && state.output !== undefined) {
          onEvent({
            type: "tool_result",
            toolName,
            toolResult: state.output,
            sessionId: event.sessionID,
          });
        }
        break;
      }

      case "step_finish": {
        const cost = event.part.cost;
        onEvent({
          type: "result",
          costUsd: cost,
          sessionId: event.sessionID,
        });
        break;
      }

      case "error": {
        const errMsg = event.part.state?.error ?? "Unknown OpenCode error";
        onEvent({
          type: "error",
          error: errMsg,
          sessionId: event.sessionID,
        });
        break;
      }

      default:
        // step_start and other events — emit as system
        onEvent({
          type: "system",
          message: event.type,
          sessionId: event.sessionID,
        });
        break;
    }
  }
}

// =============================================================================
// Singleton export
// =============================================================================

export const opencode: AgentProvider = new OpenCodeWrapperImpl();
