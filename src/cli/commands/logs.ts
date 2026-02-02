import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { readdir, stat as statFile } from 'node:fs/promises';
import { watch } from 'node:fs';

import { stateManager } from '../../core/state.js';
import { fileExists, readTextFile } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

// =============================================================================
// Types
// =============================================================================

interface LogsOptions {
  follow?: boolean;
  tail?: string;
  plan?: boolean;
}

// =============================================================================
// Command Implementation
// =============================================================================

export function createLogsCommand(): Command {
  return new Command('logs')
    .description('Show execution logs for a ticket')
    .argument('[ticket-id]', 'Ticket ID (shows list if omitted)')
    .option('-f, --follow', 'Follow log output (like tail -f)')
    .option('-n, --tail <lines>', 'Number of lines to show', '50')
    .option('-p, --plan', 'Show the generated plan instead of execution logs')
    .action(async (ticketId: string | undefined, options: LogsOptions) => {
      const cwd = process.cwd();
      const paths = stateManager.getPaths(cwd);

      try {
        // Check if .planbot exists
        if (!(await stateManager.exists(cwd))) {
          console.error(chalk.red('Planbot is not initialized in this directory.'));
          console.log(chalk.dim('\nRun "planbot init" to get started.'));
          process.exit(1);
        }

        // If no ticket ID, list available logs
        if (!ticketId) {
          await listAvailableLogs(paths.logs, paths.plans);
          return;
        }

        // Show plan or logs
        if (options.plan) {
          await showPlan(paths.plans, ticketId);
        } else {
          await showLogs(paths.logs, ticketId, options);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        logger.error('Logs failed', { error: message });
        process.exit(1);
      }
    });
}

// =============================================================================
// Helper Functions
// =============================================================================

async function listAvailableLogs(logsDir: string, plansDir: string): Promise<void> {
  console.log('');
  console.log(chalk.bold('Available Logs:'));
  console.log(chalk.dim('─'.repeat(50)));

  // List log files
  let logFiles: string[] = [];
  if (await fileExists(logsDir)) {
    const files = await readdir(logsDir);
    logFiles = files.filter(f => f.endsWith('.log'));
  }

  // List plan files
  let planFiles: string[] = [];
  if (await fileExists(plansDir)) {
    const files = await readdir(plansDir);
    planFiles = files.filter(f => f.endsWith('.md'));
  }

  if (logFiles.length === 0 && planFiles.length === 0) {
    console.log(chalk.yellow('\nNo logs found.'));
    console.log(chalk.dim('Logs are created when tickets are processed.'));
    process.exit(0);
  }

  // Display logs
  if (logFiles.length > 0) {
    console.log('');
    console.log(chalk.bold('Execution Logs:'));
    for (const file of logFiles.sort()) {
      const ticketId = file.replace('.log', '');
      const logPath = join(logsDir, file);
      const stats = await statFile(logPath);
      const modified = stats.mtime.toLocaleString();
      const size = formatBytes(stats.size);

      console.log(`  ${chalk.cyan(ticketId)}`);
      console.log(chalk.dim(`    Modified: ${modified}  Size: ${size}`));
    }
  }

  // Display plans
  if (planFiles.length > 0) {
    console.log('');
    console.log(chalk.bold('Generated Plans:'));
    for (const file of planFiles.sort()) {
      const ticketId = file.replace('.md', '');
      const planPath = join(plansDir, file);
      const stats = await statFile(planPath);
      const modified = stats.mtime.toLocaleString();

      console.log(`  ${chalk.green(ticketId)}`);
      console.log(chalk.dim(`    Modified: ${modified}`));
    }
  }

  console.log('');
  console.log(chalk.bold('Commands:'));
  console.log(chalk.dim('  planbot logs <ticket-id>         - View execution log'));
  console.log(chalk.dim('  planbot logs <ticket-id> --plan  - View generated plan'));
  console.log(chalk.dim('  planbot logs <ticket-id> -f      - Follow log output'));
  console.log('');
}

async function showPlan(plansDir: string, ticketId: string): Promise<void> {
  const planPath = join(plansDir, `${ticketId}.md`);

  if (!(await fileExists(planPath))) {
    console.error(chalk.red(`No plan found for ticket: ${ticketId}`));
    console.log(chalk.dim('\nPlan is generated during the planning phase.'));
    process.exit(1);
  }

  const content = await readTextFile(planPath);

  console.log('');
  console.log(chalk.bold(`Plan for: ${ticketId}`));
  console.log(chalk.dim('─'.repeat(60)));
  console.log(content);
  console.log(chalk.dim('─'.repeat(60)));
}

async function showLogs(
  logsDir: string,
  ticketId: string,
  options: LogsOptions
): Promise<void> {
  const logPath = join(logsDir, `${ticketId}.log`);

  if (!(await fileExists(logPath))) {
    console.error(chalk.red(`No logs found for ticket: ${ticketId}`));
    console.log(chalk.dim('\nLogs are created when tickets are executed.'));
    process.exit(1);
  }

  const tailLines = parseInt(options.tail ?? '50', 10);

  if (options.follow) {
    await followLogs(logPath, ticketId, tailLines);
  } else {
    await displayLogs(logPath, ticketId, tailLines);
  }
}

async function displayLogs(
  logPath: string,
  ticketId: string,
  tailLines: number
): Promise<void> {
  const content = await readTextFile(logPath);
  const lines = content.split('\n');

  console.log('');
  console.log(chalk.bold(`Logs for: ${ticketId}`));
  console.log(chalk.dim('─'.repeat(60)));

  // Show tail lines
  const startIndex = Math.max(0, lines.length - tailLines);
  if (startIndex > 0) {
    console.log(chalk.dim(`... (${startIndex} earlier lines omitted, use -n to show more)`));
    console.log('');
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line) {
      console.log(formatLogLine(line));
    }
  }

  console.log(chalk.dim('─'.repeat(60)));
  console.log(chalk.dim(`Total: ${lines.length} lines`));
}

async function followLogs(
  logPath: string,
  ticketId: string,
  initialLines: number
): Promise<void> {
  console.log('');
  console.log(chalk.bold(`Following logs for: ${ticketId}`));
  console.log(chalk.dim('Press Ctrl+C to stop'));
  console.log(chalk.dim('─'.repeat(60)));

  // Show initial tail
  let content = await readTextFile(logPath);
  let lines = content.split('\n');
  const startIndex = Math.max(0, lines.length - initialLines);

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line) {
      console.log(formatLogLine(line));
    }
  }

  let lastLength = content.length;

  // Watch for changes
  const watcher = watch(logPath, async (eventType) => {
    if (eventType === 'change') {
      try {
        content = await readTextFile(logPath);

        if (content.length > lastLength) {
          const newContent = content.slice(lastLength);
          const newLines = newContent.split('\n');

          for (const line of newLines) {
            if (line) {
              console.log(formatLogLine(line));
            }
          }

          lastLength = content.length;
        }
      } catch {
        // File might be temporarily unavailable during write
      }
    }
  });

  // Handle shutdown
  const cleanup = () => {
    watcher.close();
    console.log('');
    console.log(chalk.dim('─'.repeat(60)));
    console.log(chalk.dim('Stopped following logs.'));
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Keep process alive
  await new Promise(() => {});
}

function formatLogLine(line: string): string {
  // Parse timestamp if present
  const timestampMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z)\]\s*/);

  if (timestampMatch) {
    const timestamp = timestampMatch[1];
    const rest = line.slice(timestampMatch[0].length);

    const formattedTime = new Date(timestamp!).toLocaleTimeString();

    // Color based on content
    if (rest.includes('[error]') || rest.toLowerCase().includes('error')) {
      return `${chalk.dim(formattedTime)} ${chalk.red(rest)}`;
    }
    if (rest.includes('[warn]') || rest.toLowerCase().includes('warn')) {
      return `${chalk.dim(formattedTime)} ${chalk.yellow(rest)}`;
    }
    if (rest.includes('[tool_use]')) {
      return `${chalk.dim(formattedTime)} ${chalk.cyan(rest)}`;
    }
    if (rest.includes('[tool_result]')) {
      return `${chalk.dim(formattedTime)} ${chalk.green(rest)}`;
    }

    return `${chalk.dim(formattedTime)} ${rest}`;
  }

  return line;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
