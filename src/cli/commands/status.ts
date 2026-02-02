import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { stateManager } from '../../core/state.js';
import { parseTicketsFile, type Ticket, type State } from '../../core/schemas.js';
import { fileExists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

interface StatusOptions {
  json?: boolean;
  ticketsFile?: string;
}

interface StatusData {
  initialized: boolean;
  state: State | null;
  tickets: Ticket[];
  currentTicket: Ticket | null;
  summary: {
    total: number;
    pending: number;
    completed: number;
    failed: number;
    skipped: number;
    inProgress: number;
  };
}

// =============================================================================
// Command Implementation
// =============================================================================

export function createStatusCommand(): Command {
  return new Command('status')
    .description('Show current queue status, running ticket, pending questions')
    .option('--json', 'Output as JSON')
    .option('-f, --tickets-file <path>', 'Path to tickets file')
    .action(async (options: StatusOptions) => {
      const cwd = process.cwd();

      try {
        const data = await gatherStatus(cwd, options.ticketsFile);

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        displayStatus(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(JSON.stringify({ error: message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${message}`));
        }
        logger.error('Status failed', { error: message });
        process.exit(1);
      }
    });
}

// =============================================================================
// Helper Functions
// =============================================================================

async function gatherStatus(cwd: string, ticketsFilePath?: string): Promise<StatusData> {
  const data: StatusData = {
    initialized: false,
    state: null,
    tickets: [],
    currentTicket: null,
    summary: {
      total: 0,
      pending: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      inProgress: 0,
    },
  };

  // Check initialization
  data.initialized = await stateManager.exists(cwd);

  if (data.initialized) {
    data.state = await stateManager.load(cwd);
  }

  // Load tickets if available
  let ticketsPath = ticketsFilePath
    ? resolve(cwd, ticketsFilePath)
    : resolve(cwd, 'tickets.yaml');

  // Try .json if .yaml doesn't exist
  if (!(await fileExists(ticketsPath)) && !ticketsFilePath) {
    const jsonPath = resolve(cwd, 'tickets.json');
    if (await fileExists(jsonPath)) {
      ticketsPath = jsonPath;
    }
  }

  if (await fileExists(ticketsPath)) {
    const content = await readFile(ticketsPath, 'utf-8');
    let parsed: unknown;

    if (ticketsPath.endsWith('.json')) {
      parsed = JSON.parse(content);
    } else {
      parsed = parseYaml(content);
    }

    const ticketsData = parseTicketsFile(parsed);
    data.tickets = ticketsData.tickets;

    // Calculate summary
    data.summary.total = data.tickets.length;
    for (const ticket of data.tickets) {
      switch (ticket.status) {
        case 'pending':
          data.summary.pending++;
          break;
        case 'completed':
          data.summary.completed++;
          break;
        case 'failed':
          data.summary.failed++;
          break;
        case 'skipped':
          data.summary.skipped++;
          break;
        case 'planning':
        case 'awaiting_approval':
        case 'approved':
        case 'executing':
          data.summary.inProgress++;
          break;
      }
    }

    // Find current ticket
    if (data.state?.currentTicketId) {
      data.currentTicket = data.tickets.find(t => t.id === data.state?.currentTicketId) ?? null;
    }
  }

  return data;
}

function displayStatus(data: StatusData): void {
  console.log('');

  // Initialization status
  if (!data.initialized) {
    console.log(chalk.yellow('Planbot is not initialized in this directory.'));
    console.log(chalk.dim('Run "planbot init" to get started.'));
    console.log('');
    return;
  }

  console.log(chalk.bold('Planbot Status'));
  console.log(chalk.dim('─'.repeat(50)));
  console.log('');

  // Queue summary
  if (data.tickets.length > 0) {
    console.log(chalk.bold('Queue Summary:'));
    console.log(`  Total:       ${data.summary.total}`);
    console.log(`  ${chalk.green('Completed')}:   ${data.summary.completed}`);
    console.log(`  ${chalk.blue('Pending')}:     ${data.summary.pending}`);

    if (data.summary.inProgress > 0) {
      console.log(`  ${chalk.cyan('In Progress')}: ${data.summary.inProgress}`);
    }
    if (data.summary.failed > 0) {
      console.log(`  ${chalk.red('Failed')}:      ${data.summary.failed}`);
    }
    if (data.summary.skipped > 0) {
      console.log(`  ${chalk.yellow('Skipped')}:     ${data.summary.skipped}`);
    }
    console.log('');
  } else {
    console.log(chalk.yellow('No tickets file found.'));
    console.log('');
  }

  // Current state
  if (data.state) {
    console.log(chalk.bold('Current State:'));
    console.log(`  Phase:        ${formatPhase(data.state.currentPhase)}`);

    if (data.currentTicket) {
      console.log(`  Ticket:       ${data.currentTicket.title}`);
      console.log(`  Ticket ID:    ${chalk.dim(data.currentTicket.id)}`);
      console.log(`  Status:       ${formatTicketStatus(data.currentTicket.status)}`);
    } else if (data.state.currentTicketId) {
      console.log(`  Ticket ID:    ${chalk.dim(data.state.currentTicketId)} ${chalk.red('(not found in tickets file)')}`);
    } else {
      console.log(`  Ticket:       ${chalk.dim('None')}`);
    }

    console.log(`  Started:      ${new Date(data.state.startedAt).toLocaleString()}`);
    console.log(`  Last Updated: ${new Date(data.state.lastUpdatedAt).toLocaleString()}`);

    if (data.state.pauseRequested) {
      console.log(`  ${chalk.yellow('Pause Requested')}`);
    }

    console.log('');

    // Pending questions
    if (data.state.pendingQuestions.length > 0) {
      console.log(chalk.bold.yellow(`Pending Questions (${data.state.pendingQuestions.length}):`));
      for (const q of data.state.pendingQuestions) {
        console.log(`  ${chalk.cyan(q.id)}`);
        console.log(`    Ticket: ${q.ticketId}`);
        console.log(`    Question: ${q.question.slice(0, 80)}${q.question.length > 80 ? '...' : ''}`);
        console.log(`    Asked: ${new Date(q.askedAt).toLocaleString()}`);
        console.log('');
      }

      console.log(chalk.dim('  Use "planbot respond <question-id> <answer>" to answer.'));
      console.log('');
    }
  }

  // Next steps
  console.log(chalk.bold('Commands:'));
  if (data.state?.currentPhase !== 'idle' && data.state?.currentTicketId) {
    console.log(chalk.dim('  planbot resume    - Resume processing'));
    console.log(chalk.dim('  planbot pause     - Request pause'));
    console.log(chalk.dim('  planbot stop      - Stop processing'));
  } else {
    console.log(chalk.dim('  planbot start     - Start processing queue'));
  }
  console.log(chalk.dim('  planbot list      - List all tickets'));
  console.log(chalk.dim('  planbot logs      - View logs'));
  console.log('');
}

function formatPhase(phase: string): string {
  switch (phase) {
    case 'idle':
      return chalk.dim('Idle');
    case 'planning':
      return chalk.blue('Planning');
    case 'awaiting_approval':
      return chalk.yellow('Awaiting Approval');
    case 'executing':
      return chalk.cyan('Executing');
    default:
      return phase;
  }
}

function formatTicketStatus(status: string): string {
  switch (status) {
    case 'pending':
      return chalk.blue('Pending');
    case 'planning':
      return chalk.blue('Planning');
    case 'awaiting_approval':
      return chalk.yellow('Awaiting Approval');
    case 'approved':
      return chalk.green('Approved');
    case 'executing':
      return chalk.cyan('Executing');
    case 'completed':
      return chalk.green('Completed');
    case 'failed':
      return chalk.red('Failed');
    case 'skipped':
      return chalk.yellow('Skipped');
    default:
      return status;
  }
}
