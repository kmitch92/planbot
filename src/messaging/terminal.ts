import readline from "node:readline";
import chalk from "chalk";
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
 * Configuration options for the terminal provider.
 */
export interface TerminalProviderOptions {
  /** Whether to show full plan or summary (default: false - show summary) */
  showFullPlan?: boolean;
  /** Whether to use colors (default: true) */
  colors?: boolean;
  /** Maximum width for content display (default: 60) */
  maxWidth?: number;
}

/**
 * Queued prompt request for sequential processing.
 */
interface QueuedPrompt {
  prompt: string;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}

/**
 * Box drawing characters for terminal UI.
 */
const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  teeLeft: "├",
  teeRight: "┤",
} as const;

/**
 * Status icons with color formatting.
 */
const STATUS_ICONS = {
  started: { icon: "◐", color: "blue" as const },
  completed: { icon: "✓", color: "green" as const },
  failed: { icon: "✗", color: "red" as const },
  skipped: { icon: "−", color: "yellow" as const },
} as const;

/**
 * Create a horizontal line of specified width.
 */
function horizontalLine(width: number): string {
  return BOX.horizontal.repeat(width);
}

/**
 * Pad a string to a specified width, handling ANSI codes.
 */
function padEnd(str: string, width: number): string {
  // Strip ANSI codes for length calculation
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  const padding = Math.max(0, width - stripped.length);
  return str + " ".repeat(padding);
}

/**
 * Truncate text to fit within a maximum width.
 */
function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, maxWidth - 3) + "...";
}

/**
 * Wrap text to fit within a maximum width, preserving words.
 */
function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }

    const words = paragraph.split(" ");
    let currentLine = "";

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word.length > maxWidth ? truncate(word, maxWidth) : word;
      }
    }

    if (currentLine) lines.push(currentLine);
  }

  return lines;
}

/**
 * Format plan steps for display, extracting numbered items.
 */
function formatPlanSteps(plan: string, maxWidth: number): string[] {
  const lines = plan.split("\n").filter((line) => line.trim());
  const formatted: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Check if it's a numbered item
    if (/^\d+\./.test(trimmed)) {
      const wrapped = wrapText(trimmed, maxWidth);
      formatted.push(...wrapped);
    } else if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
      const wrapped = wrapText(trimmed, maxWidth);
      formatted.push(...wrapped);
    } else {
      // Regular text
      const wrapped = wrapText(trimmed, maxWidth);
      formatted.push(...wrapped);
    }
  }

  return formatted;
}

/**
 * Terminal-based messaging provider for TTY interaction.
 * Provides formatted output and readline-based input for plan approvals and questions.
 */
class TerminalProvider implements MessagingProvider {
  readonly name = "terminal";

  private rl: readline.Interface | null = null;
  private connected = false;
  private readonly showFullPlan: boolean;
  private readonly useColors: boolean;
  private readonly maxWidth: number;
  private readonly promptQueue: QueuedPrompt[] = [];
  private isPrompting = false;
  private abortController: AbortController | null = null;

  // Callbacks set by multiplexer
  onApproval?: (response: ApprovalResponse) => void;
  onQuestionResponse?: (response: QuestionResponse) => void;

  constructor(options: TerminalProviderOptions = {}) {
    this.showFullPlan = options.showFullPlan ?? false;
    this.useColors = options.colors ?? true;
    this.maxWidth = options.maxWidth ?? 60;
  }

  /**
   * Apply color formatting if colors are enabled.
   */
  private color(
    text: string,
    colorName: "blue" | "green" | "red" | "yellow" | "gray" | "cyan" | "bold"
  ): string {
    if (!this.useColors) return text;
    return chalk[colorName](text);
  }

  /**
   * Check if we're running in an interactive TTY.
   */
  private isTTY(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  /**
   * Draw a boxed display around content.
   */
  private drawBox(title: string, content: string[]): string {
    const innerWidth = this.maxWidth - 2;
    const lines: string[] = [];

    // Top border
    lines.push(
      this.color(BOX.topLeft + horizontalLine(this.maxWidth) + BOX.topRight, "gray")
    );

    // Title line
    const titleLine = padEnd(" " + truncate(title, innerWidth), innerWidth);
    lines.push(
      this.color(BOX.vertical, "gray") +
        " " +
        this.color(titleLine, "bold") +
        this.color(BOX.vertical, "gray")
    );

    // Divider
    lines.push(
      this.color(
        BOX.teeLeft + horizontalLine(this.maxWidth) + BOX.teeRight,
        "gray"
      )
    );

    // Content lines
    for (const line of content) {
      const paddedLine = padEnd(" " + line, innerWidth + 1);
      lines.push(
        this.color(BOX.vertical, "gray") +
          paddedLine +
          " " +
          this.color(BOX.vertical, "gray")
      );
    }

    // Bottom border
    lines.push(
      this.color(
        BOX.bottomLeft + horizontalLine(this.maxWidth) + BOX.bottomRight,
        "gray"
      )
    );

    return lines.join("\n");
  }

  /**
   * Prompt user for input with queuing support.
   */
  private async prompt(promptText: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.promptQueue.push({ prompt: promptText, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Process the prompt queue sequentially.
   */
  private async processQueue(): Promise<void> {
    if (this.isPrompting || this.promptQueue.length === 0) return;

    this.isPrompting = true;
    const { prompt, resolve, reject } = this.promptQueue.shift()!;

    if (!this.rl) {
      this.isPrompting = false;
      reject(new Error("Readline interface not available"));
      return;
    }

    try {
      this.abortController = new AbortController();
      const answer = await this.askQuestion(prompt);
      resolve(answer);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        reject(new Error("Input cancelled"));
      } else {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.abortController = null;
      this.isPrompting = false;
      this.processQueue();
    }
  }

  /**
   * Ask a question using readline.
   */
  private askQuestion(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.rl) {
        reject(new Error("Readline interface not available"));
        return;
      }

      this.rl.question(prompt, (answer) => {
        resolve(answer);
      });

      // Handle abort signal
      if (this.abortController) {
        this.abortController.signal.addEventListener("abort", () => {
          reject(new Error("AbortError"));
        });
      }
    });
  }

  /**
   * Connect to the terminal.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      logger.debug("Terminal provider already connected");
      return;
    }

    if (this.isTTY()) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      // Handle SIGINT gracefully
      this.rl.on("SIGINT", () => {
        if (this.abortController) {
          this.abortController.abort();
        }
        logger.debug("Received SIGINT in terminal provider");
      });

      // Handle close event
      this.rl.on("close", () => {
        logger.debug("Readline interface closed");
        this.rl = null;
        // Reject any pending prompts
        while (this.promptQueue.length > 0) {
          const { reject } = this.promptQueue.shift()!;
          reject(new Error("Terminal closed"));
        }
      });

      logger.debug("Terminal provider connected with interactive mode");
    } else {
      logger.debug(
        "Terminal provider connected in non-interactive mode (not a TTY)"
      );
    }

    this.connected = true;
  }

  /**
   * Disconnect from the terminal.
   */
  async disconnect(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.connected = false;
    logger.debug("Terminal provider disconnected");
  }

  /**
   * Check if the terminal is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a plan for approval.
   */
  async sendPlanForApproval(plan: PlanMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("Terminal provider not connected");
    }

    const innerWidth = this.maxWidth - 4;

    // Format plan steps
    const steps = this.showFullPlan
      ? formatPlanSteps(plan.plan, innerWidth)
      : this.formatPlanSummary(plan.plan, innerWidth);

    // Build title
    const titleIcon = "📋";
    const title = `${titleIcon} Plan for: ${plan.ticketId}`;
    const subtitle = truncate(plan.ticketTitle, innerWidth);

    // Draw box with content
    const content = [subtitle, "", ...steps];
    const box = this.drawBox(title, content);

    console.log("\n" + box);

    // Handle approval in interactive mode
    if (this.isTTY() && this.rl) {
      await this.handleApprovalPrompt(plan.planId);
    } else {
      // Non-interactive mode: auto-approve with warning
      logger.warn("Non-interactive mode: auto-approving plan");
      console.log(this.color("Non-interactive mode: auto-approved", "yellow"));
      this.emitApproval(plan.planId, true);
    }
  }

  /**
   * Format a plan summary (first few steps).
   */
  private formatPlanSummary(plan: string, maxWidth: number): string[] {
    const allSteps = formatPlanSteps(plan, maxWidth);
    const maxSteps = 5;

    if (allSteps.length <= maxSteps) {
      return allSteps;
    }

    const summary = allSteps.slice(0, maxSteps);
    summary.push(this.color(`... and ${allSteps.length - maxSteps} more`, "gray"));
    return summary;
  }

  /**
   * Handle the approval prompt interaction.
   */
  private async handleApprovalPrompt(planId: string): Promise<void> {
    const promptText = this.color("Approve this plan? [Y/n/v(iew full)] ", "cyan");

    try {
      const answer = await this.prompt(promptText);
      const normalized = answer.trim().toLowerCase();

      if (normalized === "" || normalized === "y" || normalized === "yes") {
        console.log(this.color("✓ Plan approved", "green"));
        this.emitApproval(planId, true);
      } else if (normalized === "n" || normalized === "no") {
        await this.handleRejection(planId);
      } else if (normalized === "v" || normalized === "view") {
        console.log(this.color("\n[Full plan view requested - re-prompting]", "gray"));
        // Re-prompt after showing full plan
        await this.handleApprovalPrompt(planId);
      } else {
        console.log(this.color("Invalid input. Please enter Y, n, or v.", "yellow"));
        await this.handleApprovalPrompt(planId);
      }
    } catch (error) {
      logger.warn("Error during approval prompt", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Default to not approved on error
      this.emitApproval(planId, false, "Prompt cancelled or errored");
    }
  }

  /**
   * Handle plan rejection with reason prompt.
   */
  private async handleRejection(planId: string): Promise<void> {
    const promptText = this.color("Reason for rejection (optional): ", "cyan");

    try {
      const reason = await this.prompt(promptText);
      console.log(this.color("✗ Plan rejected", "red"));
      this.emitApproval(planId, false, reason.trim() || undefined);
    } catch {
      console.log(this.color("✗ Plan rejected", "red"));
      this.emitApproval(planId, false);
    }
  }

  /**
   * Emit an approval response.
   */
  private emitApproval(
    planId: string,
    approved: boolean,
    rejectionReason?: string
  ): void {
    if (this.onApproval) {
      this.onApproval({
        planId,
        approved,
        rejectionReason,
        respondedBy: "terminal",
        respondedAt: new Date(),
      });
    }
  }

  /**
   * Send a question to the user.
   */
  async sendQuestion(question: QuestionMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("Terminal provider not connected");
    }

    console.log("");
    console.log(
      this.color(`❓ Question for ticket: ${question.ticketId}`, "cyan")
    );
    console.log(this.color(`   ${question.ticketTitle}`, "gray"));
    console.log("");
    console.log(question.question);

    // Display options if provided
    if (question.options && question.options.length > 0) {
      console.log("");
      for (let i = 0; i < question.options.length; i++) {
        const option = question.options[i];
        console.log(`  ${this.color(`${i + 1}.`, "bold")} ${option.label}`);
      }
      console.log("");
    }

    // Handle in interactive mode
    if (this.isTTY() && this.rl) {
      await this.handleQuestionPrompt(question);
    } else {
      // Non-interactive mode: cannot answer questions
      logger.error("Non-interactive mode: cannot answer questions");
      console.log(
        this.color("Non-interactive mode: cannot answer question", "red")
      );
    }
  }

  /**
   * Handle the question prompt interaction.
   */
  private async handleQuestionPrompt(question: QuestionMessage): Promise<void> {
    const promptText = this.color("Your answer: ", "cyan");

    try {
      const answer = await this.prompt(promptText);

      // If options provided, validate selection
      let finalAnswer = answer.trim();
      if (question.options && question.options.length > 0) {
        const num = parseInt(finalAnswer, 10);
        if (!isNaN(num) && num >= 1 && num <= question.options.length) {
          finalAnswer = question.options[num - 1].value;
        }
      }

      this.emitQuestionResponse(question.questionId, finalAnswer);
    } catch (error) {
      logger.warn("Error during question prompt", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Emit a question response.
   */
  private emitQuestionResponse(questionId: string, answer: string): void {
    if (this.onQuestionResponse) {
      this.onQuestionResponse({
        questionId,
        answer,
        respondedBy: "terminal",
        respondedAt: new Date(),
      });
    }
  }

  /**
   * Send a status update.
   */
  async sendStatus(status: StatusMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("Terminal provider not connected");
    }

    const { icon, color } = STATUS_ICONS[status.status];
    const coloredIcon = this.color(icon, color);
    const statusText = status.status.toUpperCase();

    let line = `${coloredIcon} [${this.color(statusText, color)}] ${status.ticketId}: ${status.ticketTitle}`;

    if (status.message) {
      line += ` - ${status.message}`;
    }

    if (status.status === "failed" && status.error) {
      line += `\n   ${this.color("Error:", "red")} ${status.error}`;
    }

    console.log(line);
  }
}

/**
 * Create a terminal messaging provider.
 * @param options - Configuration options
 * @returns A MessagingProvider for terminal interaction
 */
export function createTerminalProvider(
  options?: TerminalProviderOptions
): MessagingProvider {
  return new TerminalProvider(options);
}
