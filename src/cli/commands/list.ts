import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { parseTicketsFile, type Ticket, type TicketStatus } from '../../core/schemas.js';
import { fileExists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

interface ListOptions {
  status?: string;
  json?: boolean;
  verbose?: boolean;
}

// =============================================================================
// Command Implementation
// =============================================================================

export function createListCommand(): Command {
  return new Command('list')
    .description('List all tickets with their status')
    .option('-s, --status <status>', 'Filter by status (pending, completed, failed, skipped, executing, planning, awaiting_approval)')
    .option('--json', 'Output as JSON')
    .option('-v, --verbose', 'Show detailed ticket information')
    .argument('[tickets-file]', 'Path to tickets file', 'tickets.yaml')
    .action(async (ticketsFile: string, options: ListOptions) => {
      const cwd = process.cwd();
      const ticketsPath = resolve(cwd, ticketsFile);

      try {
        // Check tickets file exists
        if (!(await fileExists(ticketsPath))) {
          // Try .json if .yaml doesn't exist
          const jsonPath = ticketsPath.replace(/\.yaml$/, '.json');
          if (await fileExists(jsonPath)) {
            return listTickets(jsonPath, options);
          }

          if (options.json) {
            console.log(JSON.stringify({ error: 'Tickets file not found' }, null, 2));
          } else {
            console.error(chalk.red(`Tickets file not found: ${ticketsPath}`));
            console.log(chalk.dim('\nRun "planbot init" to create a template.'));
          }
          process.exit(1);
        }

        await listTickets(ticketsPath, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(JSON.stringify({ error: message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${message}`));
        }
        logger.error('List failed', { error: message });
        process.exit(1);
      }
    });
}

// =============================================================================
// Helper Functions
// =============================================================================

async function listTickets(ticketsPath: string, options: ListOptions): Promise<void> {
  const content = await readFile(ticketsPath, 'utf-8');
  let parsed: unknown;

  if (ticketsPath.endsWith('.json')) {
    parsed = JSON.parse(content);
  } else {
    parsed = parseYaml(content);
  }

  const ticketsData = parseTicketsFile(parsed);
  let tickets = ticketsData.tickets;

  // Filter by status if specified
  if (options.status) {
    const statusFilter = options.status.toLowerCase() as TicketStatus;
    const validStatuses: TicketStatus[] = [
      'pending', 'planning', 'awaiting_approval', 'approved',
      'executing', 'completed', 'failed', 'skipped'
    ];

    if (!validStatuses.includes(statusFilter)) {
      if (options.json) {
        console.log(JSON.stringify({
          error: `Invalid status: ${options.status}`,
          validStatuses
        }, null, 2));
      } else {
        console.error(chalk.red(`Invalid status: ${options.status}`));
        console.log(chalk.dim(`Valid statuses: ${validStatuses.join(', ')}`));
      }
      process.exit(1);
    }

    tickets = tickets.filter(t => t.status === statusFilter);
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify(tickets, null, 2));
    return;
  }

  if (tickets.length === 0) {
    if (options.status) {
      console.log(chalk.yellow(`No tickets with status: ${options.status}`));
    } else {
      console.log(chalk.yellow('No tickets found.'));
    }
    return;
  }

  console.log('');
  console.log(chalk.bold(`Tickets (${tickets.length})`));
  console.log(chalk.dim('─'.repeat(70)));
  console.log('');

  for (const ticket of tickets) {
    displayTicket(ticket, options.verbose ?? false);
  }

  // Summary
  const summary = {
    pending: tickets.filter(t => t.status === 'pending').length,
    completed: tickets.filter(t => t.status === 'completed').length,
    failed: tickets.filter(t => t.status === 'failed').length,
    skipped: tickets.filter(t => t.status === 'skipped').length,
    inProgress: tickets.filter(t =>
      ['planning', 'awaiting_approval', 'approved', 'executing'].includes(t.status)
    ).length,
  };

  console.log(chalk.dim('─'.repeat(70)));
  console.log('');
  console.log(chalk.bold('Summary:'));
  console.log(`  ${chalk.green('Completed')}: ${summary.completed}  ${chalk.blue('Pending')}: ${summary.pending}  ${chalk.cyan('In Progress')}: ${summary.inProgress}  ${chalk.red('Failed')}: ${summary.failed}  ${chalk.yellow('Skipped')}: ${summary.skipped}`);
  console.log('');
}

function displayTicket(ticket: Ticket, verbose: boolean): void {
  const statusIcon = getStatusIcon(ticket.status);
  const statusColor = getStatusColor(ticket.status);
  const priorityBadge = ticket.priority > 0
    ? chalk.magenta(` [P${ticket.priority}]`)
    : '';

  console.log(
    `${statusIcon} ${chalk.bold(ticket.id)}${priorityBadge} - ${ticket.title}`
  );
  console.log(`  ${statusColor(ticket.status)}`);

  if (verbose) {
    // Description (truncated)
    const desc = ticket.description.split('\n')[0]?.slice(0, 80) ?? '';
    console.log(chalk.dim(`  ${desc}${ticket.description.length > 80 ? '...' : ''}`));

    // Dependencies
    if (ticket.dependencies && ticket.dependencies.length > 0) {
      console.log(chalk.dim(`  Dependencies: ${ticket.dependencies.join(', ')}`));
    }

    // Acceptance criteria
    if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
      console.log(chalk.dim(`  Acceptance Criteria: ${ticket.acceptanceCriteria.length} items`));
    }

    // Metadata
    if (ticket.metadata && Object.keys(ticket.metadata).length > 0) {
      const meta = Object.entries(ticket.metadata)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      console.log(chalk.dim(`  Metadata: ${meta}`));
    }
  }

  console.log('');
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'pending':
      return chalk.blue('\u25CB'); // ○
    case 'planning':
    case 'awaiting_approval':
    case 'approved':
    case 'executing':
      return chalk.cyan('\u25D4'); // ◔
    case 'completed':
      return chalk.green('\u2714'); // ✔
    case 'failed':
      return chalk.red('\u2718'); // ✘
    case 'skipped':
      return chalk.yellow('\u25CB'); // ○
    default:
      return chalk.dim('\u25CB'); // ○
  }
}

function getStatusColor(status: string): (text: string) => string {
  switch (status) {
    case 'pending':
      return chalk.blue;
    case 'planning':
      return chalk.cyan;
    case 'awaiting_approval':
      return chalk.yellow;
    case 'approved':
      return chalk.green;
    case 'executing':
      return chalk.cyan;
    case 'completed':
      return chalk.green;
    case 'failed':
      return chalk.red;
    case 'skipped':
      return chalk.yellow;
    default:
      return chalk.dim;
  }
}
