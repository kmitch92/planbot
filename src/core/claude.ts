import { spawn, ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  verbose?: boolean;
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
  generatePlan(prompt: string, options?: ClaudeOptions, onOutput?: (text: string) => void): Promise<PlanResult>;

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
  message?: string | Record<string, unknown>;
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
  async generatePlan(prompt: string, options: ClaudeOptions = {}, onOutput?: (text: string) => void): Promise<PlanResult> {
    const { model, timeout = 900000, cwd, verbose } = options;

    logger.info('Generating plan with Claude', { model, timeout });

    return new Promise((resolve) => {
      const args = [
        '--print',
        '--verbose',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--permission-mode', 'plan',
      ];
      if (model) {
        args.push('--model', model);
      }

      const proc = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Write raw output to log file for debugging
      let logStream: ReturnType<typeof createWriteStream> | null = null;
      if (verbose && cwd) {
        const logDir = join(cwd, '.planbot', 'logs');
        mkdirSync(logDir, { recursive: true });
        const logPath = join(logDir, `plan-${Date.now()}.log`);
        logStream = createWriteStream(logPath, { flags: 'w' });
        logStream.write(`=== Plan generation started at ${new Date().toISOString()} ===\n`);
        logStream.write(`=== Args: ${args.join(' ')} ===\n\n`);
        logger.info('Raw output log', { path: logPath });
      }

      const assistantMessages: string[] = [];
      let costUsd: number | undefined;
      let sessionId: string | undefined;
      let errorMessage: string | undefined;
      let timedOut = false;
      let lineBuffer = '';
      let stderrOutput = '';
      let eventCount = 0;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        logger.warn('Plan generation timed out', { timeout });
      }, timeout);

      proc.stdout?.on('data', (chunk: Buffer) => {
        const data = chunk.toString();
        logStream?.write(data);
        onOutput?.(data);

        lineBuffer += data;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const type = parsed.type as string | undefined;
            eventCount++;

            // Log first 5 events and all assistant/result events for format diagnosis
            if (verbose && (eventCount <= 5 || type === 'assistant' || type === 'result')) {
              logger.info('Plan stream event', {
                eventCount,
                type,
                keys: Object.keys(parsed).join(','),
                messageType: typeof parsed.message,
                hasContent: 'content' in parsed,
                messageKeys: parsed.message && typeof parsed.message === 'object'
                  ? Object.keys(parsed.message as Record<string, unknown>).join(',')
                  : undefined,
                preview: JSON.stringify(parsed).slice(0, 300),
              });
            }

            if (type === 'assistant') {
              const text = this.extractTextContent(parsed as any);
              if (text) {
                assistantMessages.push(text);
              }
            } else if (type === 'result') {
              costUsd = parsed.total_cost_usd as number | undefined
                ?? parsed.cost_usd as number | undefined;
              sessionId = parsed.session_id as string | undefined;
              // Also check if result has text content
              const resultText = parsed.result as string | undefined;
              if (resultText) {
                assistantMessages.push(resultText);
              }
            } else if (type === 'error') {
              errorMessage = (parsed.error ?? parsed.message) as string | undefined;
            }
          } catch {
            // Not valid JSON, skip
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        logStream?.write(`[STDERR] ${text}`);
        stderrOutput += text;
        onOutput?.(text);
        logger.warn('Claude stderr', { text: text.trim().slice(0, 500) });
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
        logStream?.end();

        // Process remaining buffer
        if (lineBuffer.trim()) {
          try {
            const parsed = JSON.parse(lineBuffer) as Record<string, unknown>;
            const type = parsed.type as string | undefined;
            if (type === 'assistant') {
              const text = this.extractTextContent(parsed as any);
              if (text) assistantMessages.push(text);
            } else if (type === 'result') {
              costUsd = parsed.total_cost_usd as number | undefined
                ?? parsed.cost_usd as number | undefined;
              sessionId = parsed.session_id as string | undefined;
              const resultText = parsed.result as string | undefined;
              if (resultText) assistantMessages.push(resultText);
            } else if (type === 'error') {
              errorMessage = (parsed.error ?? parsed.message) as string | undefined;
            }
          } catch {
            // Not valid JSON
          }
        }

        logger.info('Claude plan process exited', {
          code,
          assistantMessages: assistantMessages.length,
          totalPlanChars: assistantMessages.join('').length,
          costUsd,
          sessionId,
        });

        if (timedOut) {
          resolve({
            success: false,
            error: 'Plan generation timed out',
            costUsd,
          });
          return;
        }

        if (errorMessage) {
          resolve({
            success: false,
            error: errorMessage,
            costUsd,
          });
          return;
        }

        if (code !== 0) {
          resolve({
            success: false,
            error: stderrOutput.trim() || `Claude exited with code ${code}`,
            costUsd,
          });
          return;
        }

        // Use the LAST assistant message as the plan (it's typically the final summary).
        // If there's only one, use it. If the last one is very short, concatenate all.
        let plan = '';
        if (assistantMessages.length > 0) {
          const lastMessage = assistantMessages[assistantMessages.length - 1];
          if (assistantMessages.length === 1 || lastMessage.length > 100) {
            plan = lastMessage;
          } else {
            // Last message is short — likely just a conclusion.
            // Use all assistant messages as the plan.
            plan = assistantMessages.join('\n\n');
          }
        }

        resolve({
          success: true,
          plan,
          costUsd,
        });
      });

      // Write prompt as stream-json input
      const initialMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: prompt,
        },
      };
      proc.stdin?.write(JSON.stringify(initialMessage) + '\n');
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
    const { model, sessionId, skipPermissions = false, timeout = 1800000, cwd, verbose } = options;

    logger.debug('Executing with Claude', { model, sessionId, skipPermissions });

    return this.runStreamingProcess(prompt, {
      model,
      sessionId,
      skipPermissions,
      timeout,
      cwd,
      verbose,
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
    const { model, skipPermissions = false, timeout = 1800000, cwd, verbose } = options;

    logger.debug('Resuming Claude session', { sessionId, model });

    return this.runStreamingProcess(input, {
      model,
      sessionId,
      skipPermissions,
      timeout,
      cwd,
      resume: true,
      verbose,
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
      model?: Model;
      sessionId?: string;
      skipPermissions: boolean;
      timeout: number;
      cwd?: string;
      resume?: boolean;
      verbose?: boolean;
    },
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult> {
    const { model, sessionId, skipPermissions, timeout, cwd, resume, verbose } = options;

    return new Promise((resolve) => {
      const args = [
        '--print',
        '--verbose',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ];
      if (model) {
        args.push('--model', model);
      }

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

      // Write raw output to log file for debugging
      let logStream: ReturnType<typeof createWriteStream> | null = null;
      if (verbose && cwd) {
        const logDir = join(cwd, '.planbot', 'logs');
        mkdirSync(logDir, { recursive: true });
        const logPath = join(logDir, `exec-${Date.now()}.log`);
        logStream = createWriteStream(logPath, { flags: 'w' });
        logStream.write(`=== Execution started at ${new Date().toISOString()} ===\n`);
        logStream.write(`=== Args: ${args.join(' ')} ===\n\n`);
        logger.info('Raw output log', { path: logPath });
      }

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
        logStream?.write(data);

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
                  proc.stdin?.end();
                } else if (event.type === 'error') {
                  finalResult = {
                    success: false,
                    error: event.error,
                    costUsd: event.costUsd,
                    sessionId: event.sessionId,
                  };
                  proc.stdin?.end();
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
        logStream?.write(`[STDERR] ${text}`);
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
        logStream?.end();
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
          error: output.error ?? (typeof output.message === 'string' ? output.message : undefined),
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
      options = optionsRaw.map(o => {
        if (typeof o === 'string') return o;
        if (o && typeof o === 'object' && 'label' in o) return String((o as { label: unknown }).label);
        return String(o);
      });
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

  private extractTextContent(output: ClaudeJsonOutput): string {
    // Direct string message
    if (output.message && typeof output.message === 'string') {
      return output.message;
    }

    // Verbose format: message is an object with nested content array
    if (output.message && typeof output.message === 'object') {
      const msg = output.message as Record<string, unknown>;
      if (msg.content && Array.isArray(msg.content)) {
        const textParts = (msg.content as Array<{ type: string; text?: string }>)
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text!);
        return textParts.join('\n');
      }
    }

    // Top-level content array
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
