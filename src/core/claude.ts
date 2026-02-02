import { spawn, ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { Model } from './schemas.js';

// =============================================================================
// Types and Interfaces
// =============================================================================

export interface ClaudeOptions {
  model?: Model;
  sessionId?: string;
  skipPermissions?: boolean;
  timeout?: number;
  cwd?: string;
}

export interface PlanResult {
  success: boolean;
  plan?: string;
  error?: string;
  costUsd?: number;
}

export interface StreamEvent {
  type: 'init' | 'user' | 'assistant' | 'result' | 'tool_use' | 'tool_result' | 'error' | 'system';
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
}

export interface ExecutionCallbacks {
  onEvent?: (event: StreamEvent) => void;
  onQuestion?: (question: { id: string; text: string; options?: string[] }) => Promise<string>;
  onOutput?: (text: string) => void;
}

export interface ExecutionResult {
  success: boolean;
  error?: string;
  costUsd?: number;
  sessionId?: string;
}

export interface ClaudeWrapper {
  /** Generate a plan in plan mode (uses --permission-mode plan) */
  generatePlan(prompt: string, options?: ClaudeOptions): Promise<PlanResult>;

  /** Execute with streaming, handling questions */
  execute(
    prompt: string,
    options: ClaudeOptions,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult>;

  /** Resume existing session */
  resume(
    sessionId: string,
    input: string,
    options: ClaudeOptions,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult>;

  /** Send answer to pending question (writes to stdin) */
  answerQuestion(answer: string): void;

  /** Abort current execution */
  abort(): void;
}

// =============================================================================
// Internal Types
// =============================================================================

interface ClaudeJsonOutput {
  type?: string;
  result?: string;
  cost_usd?: number;
  session_id?: string;
  error?: string;
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

// =============================================================================
// Claude CLI Wrapper Implementation
// =============================================================================

class ClaudeWrapperImpl implements ClaudeWrapper {
  private currentProcess: ChildProcess | null = null;

  /**
   * Generate a plan using Claude's plan permission mode
   */
  async generatePlan(prompt: string, options: ClaudeOptions = {}): Promise<PlanResult> {
    const { model = 'sonnet', timeout = 300000, cwd } = options;

    logger.debug('Generating plan with Claude', { model, timeout });

    return new Promise((resolve) => {
      const args = [
        '--print',
        '--output-format', 'json',
        '--permission-mode', 'plan',
        '--model', model,
      ];

      const proc = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        logger.warn('Plan generation timed out', { timeout });
      }, timeout);

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        logger.error('Failed to spawn claude process', { error: err.message });
        resolve({
          success: false,
          error: `Failed to spawn claude: ${err.message}`,
        });
      });

      proc.on('close', (code) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({
            success: false,
            error: 'Plan generation timed out',
          });
          return;
        }

        if (code !== 0) {
          logger.error('Claude exited with non-zero code', { code, stderr });
          resolve({
            success: false,
            error: stderr || `Claude exited with code ${code}`,
          });
          return;
        }

        try {
          const output = this.parseJsonOutput(stdout);

          if (output.error) {
            resolve({
              success: false,
              error: output.error,
              costUsd: output.cost_usd,
            });
            return;
          }

          const plan = this.extractPlanContent(output);

          resolve({
            success: true,
            plan,
            costUsd: output.cost_usd,
          });
        } catch (err) {
          logger.error('Failed to parse Claude output', {
            error: err instanceof Error ? err.message : String(err),
            stdout: stdout.slice(0, 500),
          });
          resolve({
            success: false,
            error: `Failed to parse Claude output: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });

      // Write prompt to stdin
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  }

  /**
   * Execute a prompt with streaming output
   */
  async execute(
    prompt: string,
    options: ClaudeOptions,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult> {
    const { model = 'sonnet', sessionId, skipPermissions = false, timeout = 1800000, cwd } = options;

    logger.debug('Executing with Claude', { model, sessionId, skipPermissions });

    return this.runStreamingProcess(prompt, {
      model,
      sessionId,
      skipPermissions,
      timeout,
      cwd,
    }, callbacks);
  }

  /**
   * Resume an existing session
   */
  async resume(
    sessionId: string,
    input: string,
    options: ClaudeOptions,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult> {
    const { model = 'sonnet', skipPermissions = false, timeout = 1800000, cwd } = options;

    logger.debug('Resuming Claude session', { sessionId, model });

    return this.runStreamingProcess(input, {
      model,
      sessionId,
      skipPermissions,
      timeout,
      cwd,
      resume: true,
    }, callbacks);
  }

  /**
   * Send answer to stdin of current process
   */
  answerQuestion(answer: string): void {
    if (!this.currentProcess?.stdin?.writable) {
      logger.warn('No active process to send answer to');
      return;
    }

    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: answer,
      },
    };

    logger.debug('Sending answer to Claude', { answer: answer.slice(0, 100) });
    this.currentProcess.stdin.write(JSON.stringify(message) + '\n');
  }

  /**
   * Abort the current execution
   */
  abort(): void {
    if (!this.currentProcess) {
      logger.debug('No active process to abort');
      return;
    }

    logger.info('Aborting Claude execution');
    this.currentProcess.kill('SIGTERM');
    this.currentProcess = null;
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  private async runStreamingProcess(
    prompt: string,
    options: {
      model: Model;
      sessionId?: string;
      skipPermissions: boolean;
      timeout: number;
      cwd?: string;
      resume?: boolean;
    },
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult> {
    const { model, sessionId, skipPermissions, timeout, cwd, resume } = options;

    return new Promise((resolve) => {
      const args = [
        '--print',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--model', model,
      ];

      if (sessionId) {
        args.push('--session-id', sessionId);
      }

      if (resume && sessionId) {
        args.push('--resume', sessionId);
      }

      if (skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }

      const proc = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.currentProcess = proc;

      let finalResult: ExecutionResult = { success: false };
      let timedOut = false;
      let lineBuffer = '';

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        logger.warn('Execution timed out', { timeout });
      }, timeout);

      proc.stdout?.on('data', (chunk: Buffer) => {
        const data = chunk.toString();
        callbacks.onOutput?.(data);

        lineBuffer += data;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim()) {
            this.processStreamLine(line, callbacks, proc).then(event => {
              if (event) {
                if (event.type === 'result') {
                  finalResult = {
                    success: true,
                    costUsd: event.costUsd,
                    sessionId: event.sessionId,
                  };
                } else if (event.type === 'error') {
                  finalResult = {
                    success: false,
                    error: event.error,
                    costUsd: event.costUsd,
                    sessionId: event.sessionId,
                  };
                }
              }
            }).catch(err => {
              logger.error('Error processing stream line', {
                error: err instanceof Error ? err.message : String(err)
              });
            });
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        logger.debug('Claude stderr', { text: text.slice(0, 200) });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.currentProcess = null;
        logger.error('Failed to spawn claude process', { error: err.message });
        resolve({
          success: false,
          error: `Failed to spawn claude: ${err.message}`,
        });
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProcess = null;

        // Process remaining buffer
        if (lineBuffer.trim()) {
          this.processStreamLine(lineBuffer, callbacks, proc).catch(err => {
            logger.error('Error processing final stream line', {
              error: err instanceof Error ? err.message : String(err)
            });
          });
        }

        if (timedOut) {
          resolve({
            success: false,
            error: 'Execution timed out',
          });
          return;
        }

        if (code !== 0 && !finalResult.success) {
          resolve({
            success: false,
            error: finalResult.error ?? `Claude exited with code ${code}`,
            costUsd: finalResult.costUsd,
            sessionId: finalResult.sessionId,
          });
          return;
        }

        resolve(finalResult);
      });

      // Send initial prompt as stream-json input
      const initialMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: prompt,
        },
      };

      proc.stdin?.write(JSON.stringify(initialMessage) + '\n');
    });
  }

  private async processStreamLine(
    line: string,
    callbacks: ExecutionCallbacks,
    proc: ChildProcess
  ): Promise<StreamEvent | null> {
    try {
      const parsed = JSON.parse(line) as ClaudeJsonOutput;
      const event = this.parseStreamEvent(parsed);

      if (event) {
        callbacks.onEvent?.(event);

        // Handle AskUserQuestion tool calls
        if (event.type === 'tool_use' && event.toolName === 'AskUserQuestion') {
          await this.handleQuestion(event, callbacks, proc);
        }
      }

      return event;
    } catch {
      // Not valid JSON, ignore
      logger.debug('Non-JSON stream line', { line: line.slice(0, 100) });
      return null;
    }
  }

  private parseStreamEvent(output: ClaudeJsonOutput): StreamEvent | null {
    const type = output.type as StreamEvent['type'] | undefined;

    if (!type) {
      // Try to infer type from content
      if (output.result !== undefined) {
        return {
          type: 'result',
          result: output.result,
          costUsd: output.cost_usd,
          sessionId: output.session_id,
        };
      }
      if (output.error !== undefined) {
        return {
          type: 'error',
          error: output.error,
          costUsd: output.cost_usd,
          sessionId: output.session_id,
        };
      }
      return null;
    }

    switch (type) {
      case 'init':
        return {
          type: 'init',
          sessionId: output.session_id,
        };

      case 'assistant':
        return {
          type: 'assistant',
          message: this.extractTextContent(output),
        };

      case 'tool_use':
        return {
          type: 'tool_use',
          toolName: output.tool_name,
          toolInput: output.tool_input,
        };

      case 'tool_result':
        return {
          type: 'tool_result',
          toolResult: output.tool_result,
        };

      case 'result':
        return {
          type: 'result',
          result: output.result,
          costUsd: output.cost_usd,
          sessionId: output.session_id,
        };

      case 'error':
        return {
          type: 'error',
          error: output.error ?? output.message,
          costUsd: output.cost_usd,
          sessionId: output.session_id,
        };

      case 'user':
      case 'system':
        return {
          type,
          message: this.extractTextContent(output),
        };

      default:
        return null;
    }
  }

  private async handleQuestion(
    event: StreamEvent,
    callbacks: ExecutionCallbacks,
    proc: ChildProcess
  ): Promise<void> {
    if (!callbacks.onQuestion) {
      logger.warn('Question received but no onQuestion callback provided');
      return;
    }

    const input = event.toolInput ?? {};
    const questionText = String(input.question ?? input.text ?? '');
    const optionsRaw = input.options;

    let options: string[] | undefined;
    if (Array.isArray(optionsRaw)) {
      options = optionsRaw.map(o => String(o));
    }

    const questionId = randomBytes(8).toString('hex');

    logger.debug('Handling question from Claude', { questionId, questionText: questionText.slice(0, 100) });

    try {
      const answer = await callbacks.onQuestion({
        id: questionId,
        text: questionText,
        options,
      });

      // Send answer back to Claude
      if (proc.stdin?.writable) {
        const message = {
          type: 'user',
          message: {
            role: 'user',
            content: answer,
          },
        };
        proc.stdin.write(JSON.stringify(message) + '\n');
        logger.debug('Sent answer to Claude', { questionId, answer: answer.slice(0, 100) });
      }
    } catch (err) {
      logger.error('Error handling question', {
        questionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private parseJsonOutput(stdout: string): ClaudeJsonOutput {
    // Handle both single JSON and stream-json output
    const trimmed = stdout.trim();

    // Try parsing as single JSON object first
    if (trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed) as ClaudeJsonOutput;
      } catch {
        // Fall through to line-by-line parsing
      }
    }

    // Parse as stream-json (newline-delimited)
    const lines = trimmed.split('\n');
    let lastResult: ClaudeJsonOutput = {};

    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line) as ClaudeJsonOutput;
          // Keep the last result-type message
          if (parsed.type === 'result' || parsed.result !== undefined) {
            lastResult = { ...lastResult, ...parsed };
          } else if (parsed.type === 'error' || parsed.error !== undefined) {
            lastResult = { ...lastResult, ...parsed };
          } else if (parsed.session_id) {
            lastResult.session_id = parsed.session_id;
          }
          if (parsed.cost_usd !== undefined) {
            lastResult.cost_usd = parsed.cost_usd;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }

    return lastResult;
  }

  private extractPlanContent(output: ClaudeJsonOutput): string {
    // Try result field first
    if (output.result) {
      return output.result;
    }

    // Try message field
    if (output.message) {
      return output.message;
    }

    // Try content array (common Claude output format)
    if (output.content && Array.isArray(output.content)) {
      const textParts = output.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text);
      return textParts.join('\n');
    }

    return '';
  }

  private extractTextContent(output: ClaudeJsonOutput): string {
    if (output.message && typeof output.message === 'string') {
      return output.message;
    }

    if (output.content && Array.isArray(output.content)) {
      const textParts = output.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text);
      return textParts.join('\n');
    }

    return '';
  }
}

// =============================================================================
// Exported Instance
// =============================================================================

/**
 * Claude CLI wrapper instance for plan generation and execution
 */
export const claude: ClaudeWrapper = new ClaudeWrapperImpl();
