#!/usr/bin/env node

import 'dotenv/config';

import { Command } from 'commander';
import chalk from 'chalk';

// Command imports
import { createInitCommand } from './commands/init.js';
import { createStartCommand } from './commands/start.js';
import { createResumeCommand } from './commands/resume.js';
import { createStatusCommand } from './commands/status.js';
import { createListCommand } from './commands/list.js';
import { createLogsCommand } from './commands/logs.js';
import {
  createApproveCommand,
  createRejectCommand,
  createRespondCommand,
  createSkipCommand,
  createPauseCommand,
  createStopCommand,
} from './commands/control.js';
import {
  createValidateCommand,
  createPlanCommand,
  createServeCommand,
  createResetCommand,
  createClearCommand,
} from './commands/utility.js';
import { createAttachCommand } from './commands/attach.js';

// =============================================================================
// Program Setup
// =============================================================================

const program = new Command();

program
  .name('planbot')
  .description('Autonomous ticket processing powered by Claude')
  .version('0.1.0')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('-q, --quiet', 'Suppress non-essential output')
  .option('-c, --config <path>', 'Path to configuration file')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();

    // Set log level based on flags
    if (opts.verbose) {
      process.env.PLANBOT_LOG_LEVEL = 'debug';
    } else if (opts.quiet) {
      process.env.PLANBOT_LOG_LEVEL = 'error';
    }
  });

// =============================================================================
// Register Commands
// =============================================================================

// Core workflow commands
program.addCommand(createInitCommand());
program.addCommand(createStartCommand());
program.addCommand(createResumeCommand());
program.addCommand(createStatusCommand());
program.addCommand(createListCommand());
program.addCommand(createLogsCommand());

// Control commands
program.addCommand(createApproveCommand());
program.addCommand(createRejectCommand());
program.addCommand(createRespondCommand());
program.addCommand(createSkipCommand());
program.addCommand(createPauseCommand());
program.addCommand(createStopCommand());

// Utility commands
program.addCommand(createValidateCommand());
program.addCommand(createAttachCommand());
program.addCommand(createPlanCommand());
program.addCommand(createServeCommand());
program.addCommand(createResetCommand());
program.addCommand(createClearCommand());

// =============================================================================
// Error Handling
// =============================================================================

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  console.error(chalk.red('\nUnexpected error:'));
  console.error(chalk.red(error.message));

  if (process.env.PLANBOT_LOG_LEVEL === 'debug') {
    console.error(chalk.dim(error.stack));
  }

  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red('\nUnhandled promise rejection:'));
  console.error(chalk.red(reason instanceof Error ? reason.message : String(reason)));

  if (process.env.PLANBOT_LOG_LEVEL === 'debug' && reason instanceof Error) {
    console.error(chalk.dim(reason.stack));
  }

  process.exit(1);
});

// =============================================================================
// Default Action (TUI)
// =============================================================================

program.action(async () => {
  const { launchTUI } = await import('../tui/index.js');
  await launchTUI();
});

// =============================================================================
// Parse and Execute
// =============================================================================

program.parse();
