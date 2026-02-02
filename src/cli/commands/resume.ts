import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { createOrchestrator, type Orchestrator } from '../../core/orchestrator.js';
import { stateManager } from '../../core/state.js';
import { parseTicketsFile } from '../../core/schemas.js';
import { createMultiplexer } from '../../messaging/index.js';
import { createTerminalProvider } from '../../messaging/terminal.js';
import { fileExists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

interface ResumeOptions {
  ticketsFile?: string;
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

export function createResumeCommand(): Command {
  return new Command('resume')
    .description('Resume from saved state in .planbot/')
    .option('-f, --tickets-file <path>', 'Path to tickets file (default: tickets.yaml)')
    .action(async (options: ResumeOptions) => {
      const cwd = process.cwd();
      const spinner = ora('Checking state...').start();

      try {
        // Check if .planbot exists
        const exists = await stateManager.exists(cwd);
        if (!exists) {
          spinner.fail('No planbot state found');
          console.log(chalk.dim('\nRun "planbot start" to begin processing.'));
          process.exit(1);
        }

        // Load state
        const state = await stateManager.load(cwd);
        spinner.text = 'Loading saved state...';

        // Check if there's anything to resume
        if (state.currentPhase === 'idle' && !state.currentTicketId) {
          spinner.info('No active work to resume');
          console.log(chalk.dim('\nRun "planbot start" to begin processing.'));
          process.exit(0);
        }

        // Determine tickets file path
        let ticketsPath = options.ticketsFile
          ? resolve(cwd, options.ticketsFile)
          : resolve(cwd, 'tickets.yaml');

        // Try .json if .yaml doesn't exist
        if (!(await fileExists(ticketsPath)) && !options.ticketsFile) {
          const jsonPath = resolve(cwd, 'tickets.json');
          if (await fileExists(jsonPath)) {
            ticketsPath = jsonPath;
          }
        }

        if (!(await fileExists(ticketsPath))) {
          spinner.fail(`Tickets file not found: ${ticketsPath}`);
          console.log(chalk.dim('\nSpecify the path with --tickets-file'));
          process.exit(1);
        }

        // Load tickets
        const content = await readFile(ticketsPath, 'utf-8');
        let parsed: unknown;

        if (ticketsPath.endsWith('.json')) {
          parsed = JSON.parse(content);
        } else {
          parsed = parseYaml(content);
        }

        const ticketsData = parseTicketsFile(parsed);
        spinner.text = 'Loading tickets...';

        // Create terminal provider for approvals and questions
        const terminal = createTerminalProvider({
          showFullPlan: false,
          colors: true,
        });

        // Create multiplexer
        const multiplexer = createMultiplexer({
          approvalTimeout: ticketsData.config.timeouts.approval,
          questionTimeout: ticketsData.config.timeouts.question,
        });

        // Add terminal provider to multiplexer
        multiplexer.addProvider(terminal);

        // Connect providers
        await multiplexer.connectAll();

        // Create orchestrator
        const orchestrator = createOrchestrator({
          projectRoot: cwd,
          ticketsFile: ticketsPath,
          multiplexer,
        });

        // Set up event handlers
        setupEventHandlers(orchestrator, spinner);

        // Set up shutdown handler
        setupShutdownHandler(orchestrator);

        spinner.succeed('State loaded');
        console.log('');

        // Display resume info
        displayResumeInfo(state);

        // Resume processing
        console.log(chalk.bold('\nResuming queue processing...\n'));
        await orchestrator.resume();

      } catch (err) {
        spinner.fail('Failed to resume');
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}`));
        logger.error('Resume failed', { error: message });
        process.exit(1);
      }
    });
}

// =============================================================================
// Helper Functions
// =============================================================================

function setupEventHandlers(orchestrator: Orchestrator, _spinner: ReturnType<typeof ora>): void {
  orchestrator.on('ticket:start', (ticket) => {
    console.log(chalk.blue.bold(`\n>>> Starting: ${ticket.title}`));
    console.log(chalk.dim(`    ID: ${ticket.id}`));
  });

  orchestrator.on('ticket:plan-generated', (ticket, plan) => {
    console.log(chalk.green(`\n>>> Plan generated for: ${ticket.title}`));
    console.log(chalk.dim('─'.repeat(60)));
    console.log(plan.slice(0, 500));
    if (plan.length > 500) {
      console.log(chalk.dim(`\n... (${plan.length - 500} more characters)`));
    }
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
  });

  orchestrator.on('ticket:completed', (ticket) => {
    console.log(chalk.green.bold(`\n>>> Completed: ${ticket.title}`));
  });

  orchestrator.on('ticket:failed', (ticket, error) => {
    console.log(chalk.red.bold(`\n>>> Failed: ${ticket.title}`));
    console.log(chalk.red(`    Error: ${error}`));
  });

  orchestrator.on('ticket:skipped', (ticket) => {
    console.log(chalk.yellow(`\n>>> Skipped: ${ticket.title}`));
  });

  orchestrator.on('question', (ticket, question) => {
    console.log(chalk.cyan(`\n>>> Question for: ${ticket.title}`));
    console.log(chalk.white(`    ${question}`));
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
  });
}

function displayResumeInfo(state: {
  currentTicketId: string | null;
  currentPhase: string;
  startedAt: string;
  lastUpdatedAt: string;
  pendingQuestions: Array<{ id: string; question: string }>;
}): void {
  console.log(chalk.bold('Resuming from:'));
  console.log(chalk.dim(`  Current ticket: ${state.currentTicketId ?? 'None'}`));
  console.log(chalk.dim(`  Phase:          ${state.currentPhase}`));
  console.log(chalk.dim(`  Started:        ${new Date(state.startedAt).toLocaleString()}`));
  console.log(chalk.dim(`  Last update:    ${new Date(state.lastUpdatedAt).toLocaleString()}`));

  if (state.pendingQuestions.length > 0) {
    console.log('');
    console.log(chalk.yellow(`Pending questions: ${state.pendingQuestions.length}`));
    for (const q of state.pendingQuestions) {
      console.log(chalk.dim(`  - ${q.question.slice(0, 50)}...`));
    }
  }
}
