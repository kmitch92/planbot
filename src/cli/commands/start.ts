import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { randomBytes } from 'node:crypto';

import { createOrchestrator, type Orchestrator } from '../../core/orchestrator.js';
import { stateManager } from '../../core/state.js';
import { parseTicketsFile, validateTicketDependencies, resolveEnvVars } from '../../core/schemas.js';
import type { Ticket } from '../../core/schemas.js';
import { createMultiplexer, TimeoutError, createTelegramProvider } from '../../messaging/index.js';
import { createTerminalProvider } from '../../messaging/terminal.js';
import { fileExists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

interface StartOptions {
  dryRun?: boolean;
  autoApprove?: boolean;
  skipPermissions?: boolean;
  continuous?: boolean;
  continuousTimeout?: number;
}

// =============================================================================
// Continuous Mode Helpers
// =============================================================================

const EXIT_COMMANDS = new Set(['exit', 'quit', 'q', 'done', 'stop']);

export function isExitCommand(input: string): boolean {
  return EXIT_COMMANDS.has(input.trim().toLowerCase());
}

export function generateContinuousTicketId(): string {
  return `cont-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

export function parseUserInputToTicket(input: string): Ticket | null {
  // Normalize CRLF to LF
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = normalized.trim();
  if (!trimmed) return null;

  const firstNewline = trimmed.indexOf('\n');
  let title: string;
  let description: string;

  if (firstNewline === -1) {
    title = trimmed.slice(0, 200);
    description = trimmed;
  } else {
    // Trim the title but preserve description whitespace
    title = trimmed.slice(0, Math.min(firstNewline, 200)).trim();
    const rest = trimmed.slice(firstNewline + 1);
    description = rest || title;
  }

  return {
    id: generateContinuousTicketId(),
    title,
    description,
    priority: 0,
    status: 'pending' as const,
  };
}

function displayCompletionSummary(tickets: Ticket[]): void {
  const completed = tickets.filter(t => t.status === 'completed').length;
  const failed = tickets.filter(t => t.status === 'failed').length;
  const skipped = tickets.filter(t => t.status === 'skipped').length;

  console.log(chalk.bold('\nQueue Summary:'));
  console.log(chalk.green(`  Completed: ${completed}`));
  if (failed > 0) console.log(chalk.red(`  Failed:    ${failed}`));
  if (skipped > 0) console.log(chalk.yellow(`  Skipped:   ${skipped}`));
}

async function runContinuousLoop(
  orchestrator: Orchestrator,
  multiplexer: ReturnType<typeof createMultiplexer>,
  _timeout: number
): Promise<void> {
  // Note: timeout parameter reserved for future per-question timeout support
  // Currently uses multiplexer's configured questionTimeout
  let emptyInputCount = 0;
  const maxEmptyInputs = 3;

  while (true) {
    displayCompletionSummary(orchestrator.getTickets());
    console.log(chalk.cyan('\n--- Continuous Mode ---'));

    try {
      const response = await multiplexer.askQuestion({
        questionId: `continuous-${Date.now()}`,
        ticketId: 'continuous-mode',
        ticketTitle: 'Continuous Mode',
        question: 'Enter your next plan (or "exit" to quit):',
      });

      const answer = response.answer.trim();

      if (isExitCommand(answer)) {
        console.log(chalk.green('\nExiting continuous mode.'));
        break;
      }

      if (!answer) {
        emptyInputCount++;
        if (emptyInputCount >= maxEmptyInputs) {
          console.log(chalk.yellow('\nNo input received. Exiting.'));
          break;
        }
        console.log(chalk.yellow(`Enter a plan or 'exit' (${maxEmptyInputs - emptyInputCount} attempts left)`));
        continue;
      }

      emptyInputCount = 0;

      const ticket = parseUserInputToTicket(response.answer);
      if (!ticket) {
        console.log(chalk.yellow('Could not parse input. Try again.'));
        continue;
      }

      console.log(chalk.blue(`\nQueuing: ${ticket.title}`));
      console.log(chalk.dim(`ID: ${ticket.id}\n`));

      await orchestrator.queueTicket(ticket);
      await orchestrator.start();

    } catch (err) {
      if (err instanceof TimeoutError) {
        console.log(chalk.yellow('\nTimeout waiting for input. Exiting.'));
        break;
      }
      throw err;
    }
  }

  await multiplexer.disconnectAll();
}

// =============================================================================
// Graceful Shutdown Handler
// =============================================================================

function setupShutdownHandler(orchestrator: Orchestrator): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(chalk.yellow('\nForce quitting...'));
      process.exit(1);
    }

    shuttingDown = true;
    console.log(chalk.yellow(`\nReceived ${signal}. Gracefully stopping...`));

    try {
      await orchestrator.stop();
      console.log(chalk.green('Stopped. Resume with: planbot resume'));
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error during shutdown: ${message}`));
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// =============================================================================
// Command Implementation
// =============================================================================

export function createStartCommand(): Command {
  return new Command('start')
    .description('Start processing the ticket queue')
    .argument('[tickets-file]', 'Path to tickets.yaml or tickets.json', 'tickets.yaml')
    .option('--dry-run', 'Simulate execution without making changes')
    .option('--auto-approve', 'Automatically approve all plans')
    .option('--skip-permissions', 'Skip Claude permission prompts (dangerous)')
    .option('-C, --continuous', 'Keep running and prompt for new plans after completion')
    .option('--continuous-timeout <ms>', 'Timeout for next plan prompt (default: 1 hour)', parseInt)
    .action(async (ticketsFile: string, options: StartOptions) => {
      const cwd = process.cwd();
      const ticketsPath = resolve(cwd, ticketsFile);

      const spinner = ora('Loading tickets...').start();

      try {
        // Check tickets file exists
        if (!(await fileExists(ticketsPath))) {
          spinner.fail(`Tickets file not found: ${ticketsPath}`);
          console.log(chalk.dim('\nRun "planbot init" to create a template.'));
          process.exit(1);
        }

        // Load and validate tickets
        const content = await readFile(ticketsPath, 'utf-8');
        let parsed: unknown;

        if (ticketsPath.endsWith('.json')) {
          parsed = JSON.parse(content);
        } else {
          parsed = parseYaml(content);
        }

        const ticketsData = parseTicketsFile(parsed);

        // Validate dependencies
        const validation = validateTicketDependencies(ticketsData.tickets);
        if (!validation.valid) {
          spinner.fail('Invalid ticket dependencies');
          for (const error of validation.errors) {
            console.log(chalk.red(`  - ${error}`));
          }
          process.exit(1);
        }

        spinner.text = `Loaded ${ticketsData.tickets.length} tickets`;

        // Apply CLI option overrides
        const config = { ...ticketsData.config };
        if (options.autoApprove !== undefined) {
          config.autoApprove = options.autoApprove;
        }
        if (options.skipPermissions !== undefined) {
          config.skipPermissions = options.skipPermissions;
        }

        // Initialize .planbot if needed
        const exists = await stateManager.exists(cwd);
        if (!exists) {
          spinner.text = 'Initializing .planbot directory...';
          await stateManager.init(cwd);
        }

        // Create terminal provider for approvals and questions
        const terminal = createTerminalProvider({
          showFullPlan: true,
          colors: true,
        });

        // Create multiplexer
        const multiplexer = createMultiplexer({
          approvalTimeout: config.timeouts.approval,
          questionTimeout: config.timeouts.question,
        });

        // Add terminal provider to multiplexer
        multiplexer.addProvider(terminal);

        // Add Telegram provider if credentials are available
        let telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        let telegramChatId = process.env.TELEGRAM_CHAT_ID;

        if (!telegramToken && config.messaging?.provider === 'telegram') {
          telegramToken = resolveEnvVars(config.messaging.botToken);
          telegramChatId = resolveEnvVars(config.messaging.chatId);
        }

        if (telegramToken && telegramChatId) {
          logger.debug('Telegram credentials found, adding provider', {
            chatId: telegramChatId,
          });
          const telegram = createTelegramProvider({
            botToken: telegramToken,
            chatId: telegramChatId,
          });
          multiplexer.addProvider(telegram);
          console.log(chalk.dim('  Telegram notifications enabled'));
        }

        // Connect providers
        await multiplexer.connectAll();

        // Create orchestrator
        const orchestrator = createOrchestrator({
          projectRoot: cwd,
          ticketsFile: ticketsPath,
          multiplexer,
          dryRun: options.dryRun,
        });

        // Set up event handlers
        setupEventHandlers(orchestrator, spinner, options.dryRun ?? false);

        // Set up shutdown handler
        setupShutdownHandler(orchestrator);

        spinner.succeed('Ready to process tickets');
        console.log('');

        // Display queue summary
        displayQueueSummary(ticketsData.tickets);

        if (options.dryRun) {
          console.log(chalk.yellow('\nDry run mode: No changes will be made\n'));
        }

        if (options.skipPermissions) {
          console.log(chalk.red.bold('WARNING: Permission prompts disabled. Use with caution.\n'));
        }

        // Start processing
        console.log(chalk.bold('\nStarting queue processing...\n'));
        await orchestrator.start();

        // Continuous mode loop
        if (options.continuous) {
          const timeout = options.continuousTimeout ?? config.timeouts.question;
          await runContinuousLoop(orchestrator, multiplexer, timeout);
        } else {
          await multiplexer.disconnectAll();
        }

      } catch (err) {
        spinner.fail('Failed to start');
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}`));
        logger.error('Start failed', { error: message });
        process.exit(1);
      }
    });
}

// =============================================================================
// Progress Tracking
// =============================================================================

interface ExecutionProgress {
  startTime: number;
  bytesReceived: number;
  eventCounts: Record<string, number>;
  toolCalls: number;
  lastToolName: string | null;
  intervalId: NodeJS.Timeout | null;
}

let progress: ExecutionProgress | null = null;

function startProgressTracker(): void {
  progress = {
    startTime: Date.now(),
    bytesReceived: 0,
    eventCounts: {},
    toolCalls: 0,
    lastToolName: null,
    intervalId: null,
  };

  progress.intervalId = setInterval(() => {
    if (!progress) return;
    printProgressLine();
  }, 60_000);

  // Don't prevent process exit
  progress.intervalId.unref();
}

function stopProgressTracker(): void {
  if (progress?.intervalId) {
    clearInterval(progress.intervalId);
  }
  if (progress && progress.bytesReceived > 0) {
    printProgressLine(); // Print final state
  }
  progress = null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function printProgressLine(): void {
  if (!progress) return;

  const elapsed = formatElapsed(Date.now() - progress.startTime);
  const bytes = formatBytes(progress.bytesReceived);

  const parts: string[] = [elapsed, bytes + ' output'];

  if (progress.toolCalls > 0) {
    let toolPart = `${progress.toolCalls} tool calls`;
    if (progress.lastToolName) {
      toolPart += ` (last: ${progress.lastToolName})`;
    }
    parts.push(toolPart);
  }

  console.log(chalk.dim(`  ⟳ ${parts.join(' | ')}`));
}

// =============================================================================
// Helper Functions
// =============================================================================

function setupEventHandlers(
  orchestrator: Orchestrator,
  _spinner: ReturnType<typeof ora>,
  dryRun: boolean
): void {
  orchestrator.on('ticket:start', (ticket) => {
    console.log(chalk.blue.bold(`\n>>> Starting: ${ticket.title}`));
    console.log(chalk.dim(`    ID: ${ticket.id}`));
    logger.setContext({ ticketId: ticket.id, phase: 'starting' });
    startProgressTracker();
  });

  orchestrator.on('ticket:plan-generated', (ticket, plan) => {
    console.log(chalk.green(`\n>>> Plan generated for: ${ticket.title}`));
    console.log(chalk.dim('─'.repeat(60)));
    console.log(plan);
    console.log(chalk.dim('─'.repeat(60)));
  });

  orchestrator.on('ticket:approved', (ticket) => {
    console.log(chalk.green(`\n>>> Approved: ${ticket.title}`));
  });

  orchestrator.on('ticket:rejected', (ticket, reason) => {
    console.log(chalk.yellow(`\n>>> Rejected: ${ticket.title}`));
    if (reason) {
      console.log(chalk.dim(`    Reason: ${reason}`));
    }
  });

  orchestrator.on('ticket:executing', (ticket) => {
    console.log(chalk.blue(`\n>>> Executing: ${ticket.title}`));
    if (dryRun) {
      console.log(chalk.yellow('    (Dry run - no actual changes)'));
    }
  });

  orchestrator.on('ticket:output', (_ticket, text) => {
    if (progress) {
      progress.bytesReceived += Buffer.byteLength(text, 'utf-8');
    }
  });

  orchestrator.on('ticket:completed', (ticket) => {
    stopProgressTracker();
    console.log(chalk.green.bold(`\n>>> Completed: ${ticket.title}`));
  });

  orchestrator.on('ticket:failed', (ticket, error) => {
    stopProgressTracker();
    console.log(chalk.red.bold(`\n>>> Failed: ${ticket.title}`));
    console.log(chalk.red(`    Error: ${error}`));
  });

  orchestrator.on('ticket:event', (_ticket, event) => {
    if (!progress) return;
    progress.eventCounts[event.type] = (progress.eventCounts[event.type] ?? 0) + 1;
    if (event.type === 'tool_use' && event.toolName) {
      progress.toolCalls++;
      progress.lastToolName = event.toolName;
    }
  });

  orchestrator.on('ticket:skipped', (ticket) => {
    stopProgressTracker();
    console.log(chalk.yellow(`\n>>> Skipped: ${ticket.title}`));
  });

  orchestrator.on('question', (ticket, question) => {
    console.log(chalk.cyan(`\n>>> Question for: ${ticket.title}`));
    console.log(chalk.white(`    ${question}`));
  });

  orchestrator.on('queue:start', () => {
    logger.info('Queue processing started');
  });

  orchestrator.on('queue:complete', () => {
    console.log(chalk.green.bold('\n>>> Queue processing complete\n'));
  });

  orchestrator.on('queue:paused', () => {
    console.log(chalk.yellow('\n>>> Queue processing paused'));
    console.log(chalk.dim('    Resume with: planbot resume'));
  });

  orchestrator.on('error', (error) => {
    console.log(chalk.red(`\n>>> Error: ${error.message}`));
    logger.error('Orchestrator error', { error: error.message });
  });
}

function displayQueueSummary(
  tickets: Array<{ id: string; title: string; status: string; priority: number }>
): void {
  const pending = tickets.filter(t => t.status === 'pending');
  const completed = tickets.filter(t => t.status === 'completed');
  const failed = tickets.filter(t => t.status === 'failed');

  console.log(chalk.bold('Queue Summary:'));
  console.log(chalk.dim(`  Total tickets: ${tickets.length}`));
  console.log(chalk.green(`  Pending:       ${pending.length}`));
  console.log(chalk.blue(`  Completed:     ${completed.length}`));
  if (failed.length > 0) {
    console.log(chalk.red(`  Failed:        ${failed.length}`));
  }

}
