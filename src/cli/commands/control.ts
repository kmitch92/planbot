import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { stateManager } from '../../core/state.js';
import {
  parseTicketsFile,
  type Ticket,
  type TicketsFile,
} from '../../core/schemas.js';
import { fileExists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

// =============================================================================
// Approve Command
// =============================================================================

export function createApproveCommand(): Command {
  return new Command('approve')
    .description('Approve a ticket plan (when running interactively, approves via terminal)')
    .argument('<ticket-id>', 'Ticket ID to approve')
    .option('-f, --tickets-file <path>', 'Path to tickets file', 'tickets.yaml')
    .action(async (ticketId: string, options: { ticketsFile: string }) => {
      const cwd = process.cwd();

      try {
        // Check state
        if (!(await stateManager.exists(cwd))) {
          console.error(chalk.red('Planbot is not initialized.'));
          process.exit(1);
        }

        const state = await stateManager.load(cwd);

        // Check if this ticket is awaiting approval
        if (state.currentTicketId !== ticketId || state.currentPhase !== 'awaiting_approval') {
          console.error(chalk.yellow(`Ticket ${ticketId} is not currently awaiting approval.`));
          console.log(chalk.dim(`Current phase: ${state.currentPhase}`));
          console.log(chalk.dim(`Current ticket: ${state.currentTicketId ?? 'None'}`));
          process.exit(1);
        }

        // Update ticket status
        const ticketsPath = resolve(cwd, options.ticketsFile);
        await updateTicketStatus(ticketsPath, ticketId, 'approved');

        // Update state to move forward
        await stateManager.update(cwd, {
          currentPhase: 'executing',
        });

        console.log(chalk.green(`Ticket ${ticketId} approved.`));
        console.log(chalk.dim('Processing will continue when orchestrator is running.'));

        logger.info('Ticket approved via CLI', { ticketId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}

// =============================================================================
// Reject Command
// =============================================================================

export function createRejectCommand(): Command {
  return new Command('reject')
    .description('Reject a ticket plan')
    .argument('<ticket-id>', 'Ticket ID to reject')
    .argument('[reason]', 'Reason for rejection')
    .option('-f, --tickets-file <path>', 'Path to tickets file', 'tickets.yaml')
    .action(async (ticketId: string, reason: string | undefined, options: { ticketsFile: string }) => {
      const cwd = process.cwd();

      try {
        if (!(await stateManager.exists(cwd))) {
          console.error(chalk.red('Planbot is not initialized.'));
          process.exit(1);
        }

        const state = await stateManager.load(cwd);

        if (state.currentTicketId !== ticketId || state.currentPhase !== 'awaiting_approval') {
          console.error(chalk.yellow(`Ticket ${ticketId} is not currently awaiting approval.`));
          process.exit(1);
        }

        // Update ticket status to skipped
        const ticketsPath = resolve(cwd, options.ticketsFile);
        await updateTicketStatus(ticketsPath, ticketId, 'skipped');

        // Clear current ticket and reset to idle
        await stateManager.update(cwd, {
          currentTicketId: null,
          currentPhase: 'idle',
        });

        console.log(chalk.yellow(`Ticket ${ticketId} rejected.`));
        if (reason) {
          console.log(chalk.dim(`Reason: ${reason}`));
        }

        logger.info('Ticket rejected via CLI', { ticketId, reason });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}

// =============================================================================
// Respond Command
// =============================================================================

export function createRespondCommand(): Command {
  return new Command('respond')
    .description('Respond to a pending question')
    .argument('<question-id>', 'Question ID')
    .argument('<answer>', 'Your answer')
    .action(async (questionId: string, answer: string) => {
      const cwd = process.cwd();

      try {
        if (!(await stateManager.exists(cwd))) {
          console.error(chalk.red('Planbot is not initialized.'));
          process.exit(1);
        }

        const state = await stateManager.load(cwd);
        const question = state.pendingQuestions.find(q => q.id === questionId);

        if (!question) {
          console.error(chalk.red(`Question not found: ${questionId}`));

          if (state.pendingQuestions.length > 0) {
            console.log(chalk.dim('\nPending questions:'));
            for (const q of state.pendingQuestions) {
              console.log(chalk.dim(`  ${q.id}: ${q.question.slice(0, 50)}...`));
            }
          } else {
            console.log(chalk.dim('No pending questions.'));
          }
          process.exit(1);
        }

        // Note: In a real implementation, this would communicate with the running
        // orchestrator process. For now, we just record the answer in state.
        // The orchestrator would pick this up when checking for answers.

        // For CLI-only mode, we store the answer in a response file
        const paths = stateManager.getPaths(cwd);
        const responsePath = `${paths.questions}/${questionId}.response`;

        await writeFile(responsePath, JSON.stringify({
          questionId,
          answer,
          respondedAt: new Date().toISOString(),
        }), 'utf-8');

        // Remove from pending questions
        await stateManager.removePendingQuestion(cwd, questionId);

        console.log(chalk.green(`Response recorded for question ${questionId}`));
        console.log(chalk.dim('The orchestrator will receive your answer.'));

        logger.info('Question answered via CLI', { questionId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}

// =============================================================================
// Skip Command
// =============================================================================

export function createSkipCommand(): Command {
  return new Command('skip')
    .description('Skip a ticket')
    .argument('<ticket-id>', 'Ticket ID to skip')
    .option('-f, --tickets-file <path>', 'Path to tickets file', 'tickets.yaml')
    .action(async (ticketId: string, options: { ticketsFile: string }) => {
      const cwd = process.cwd();
      const ticketsPath = resolve(cwd, options.ticketsFile);

      try {
        await updateTicketStatus(ticketsPath, ticketId, 'skipped');

        // If this was the current ticket, clear state
        if (await stateManager.exists(cwd)) {
          const state = await stateManager.load(cwd);
          if (state.currentTicketId === ticketId) {
            await stateManager.update(cwd, {
              currentTicketId: null,
              currentPhase: 'idle',
            });
          }
        }

        console.log(chalk.yellow(`Ticket ${ticketId} skipped.`));
        logger.info('Ticket skipped via CLI', { ticketId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}

// =============================================================================
// Pause Command
// =============================================================================

export function createPauseCommand(): Command {
  return new Command('pause')
    .description('Request pause of running orchestrator')
    .action(async () => {
      const cwd = process.cwd();

      try {
        if (!(await stateManager.exists(cwd))) {
          console.error(chalk.red('Planbot is not initialized.'));
          process.exit(1);
        }

        await stateManager.update(cwd, {
          pauseRequested: true,
        });

        console.log(chalk.yellow('Pause requested.'));
        console.log(chalk.dim('The orchestrator will pause after the current operation completes.'));

        logger.info('Pause requested via CLI');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}

// =============================================================================
// Stop Command
// =============================================================================

export function createStopCommand(): Command {
  return new Command('stop')
    .description('Request stop of running orchestrator')
    .action(async () => {
      const cwd = process.cwd();

      try {
        if (!(await stateManager.exists(cwd))) {
          console.error(chalk.red('Planbot is not initialized.'));
          process.exit(1);
        }

        // Request pause (which triggers stop behavior)
        await stateManager.update(cwd, {
          pauseRequested: true,
        });

        // Note: In a real implementation with IPC, we'd signal the running process
        console.log(chalk.red('Stop requested.'));
        console.log(chalk.dim('The orchestrator will stop after the current operation.'));
        console.log(chalk.dim('You can resume later with: planbot resume'));

        logger.info('Stop requested via CLI');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}

// =============================================================================
// Helper Functions
// =============================================================================

async function updateTicketStatus(
  ticketsPath: string,
  ticketId: string,
  status: Ticket['status']
): Promise<void> {
  if (!(await fileExists(ticketsPath))) {
    throw new Error(`Tickets file not found: ${ticketsPath}`);
  }

  const content = await readFile(ticketsPath, 'utf-8');
  let data: TicketsFile;

  const isJson = ticketsPath.endsWith('.json');

  if (isJson) {
    data = parseTicketsFile(JSON.parse(content));
  } else {
    data = parseTicketsFile(parseYaml(content));
  }

  const ticket = data.tickets.find(t => t.id === ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }

  ticket.status = status;

  // Write back
  const output = isJson
    ? JSON.stringify(data, null, 2)
    : stringifyYaml(data, { lineWidth: 0 });

  await writeFile(ticketsPath, output, 'utf-8');
}
