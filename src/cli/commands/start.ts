import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { createOrchestrator, type Orchestrator } from '../../core/orchestrator.js';
import { stateManager } from '../../core/state.js';
import { parseTicketsFile, validateTicketDependencies } from '../../core/schemas.js';
import { createMultiplexer } from '../../messaging/index.js';
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
          showFullPlan: false,
          colors: true,
        });

        // Create multiplexer
        const multiplexer = createMultiplexer({
          approvalTimeout: config.timeouts.approval,
          questionTimeout: config.timeouts.question,
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
          dryRun: options.dryRun,
        });

        // Set up event handlers
        setupEventHandlers(orchestrator, spinner, options.dryRun ?? false);

        // Set up shutdown handler
        setupShutdownHandler(orchestrator);

        spinner.succeed('Ready to process tickets');
        console.log('');

        // Display queue summary
        displayQueueSummary(ticketsData.tickets, config);

        if (options.dryRun) {
          console.log(chalk.yellow('\nDry run mode: No changes will be made\n'));
        }

        if (options.skipPermissions) {
          console.log(chalk.red.bold('WARNING: Permission prompts disabled. Use with caution.\n'));
        }

        // Start processing
        console.log(chalk.bold('\nStarting queue processing...\n'));
        await orchestrator.start();

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
    if (dryRun) {
      console.log(chalk.yellow('    (Dry run - no actual changes)'));
    }
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
  tickets: Array<{ id: string; title: string; status: string; priority: number }>,
  config: { autoApprove: boolean; skipPermissions: boolean; model: string }
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

  console.log('');
  console.log(chalk.bold('Configuration:'));
  console.log(chalk.dim(`  Model:         ${config.model}`));
  console.log(chalk.dim(`  Auto-approve:  ${config.autoApprove ? 'Yes' : 'No'}`));
  if (config.skipPermissions) {
    console.log(chalk.red(`  Permissions:   SKIPPED`));
  }
}
