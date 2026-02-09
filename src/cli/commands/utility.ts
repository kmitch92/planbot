import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { stateManager } from '../../core/state.js';
import { claude } from '../../core/claude.js';
import {
  parseTicketsFile,
  safeParseTicketsFile,
  validateTicketDependencies,
  type Ticket,
  type TicketsFile,
} from '../../core/schemas.js';
import { createWebhookServer } from '../../messaging/webhook-server.js';
import { resolveAndValidateImages, buildImagePromptSection } from '../../core/images.js';
import { fileExists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

// =============================================================================
// Validate Command
// =============================================================================

export function createValidateCommand(): Command {
  return new Command('validate')
    .description('Validate a tickets file')
    .argument('[tickets-file]', 'Path to tickets file', 'tickets.yaml')
    .option('--json', 'Output validation results as JSON')
    .action(async (ticketsFile: string, options: { json?: boolean }) => {
      const cwd = process.cwd();
      const ticketsPath = resolve(cwd, ticketsFile);

      const results: {
        valid: boolean;
        errors: string[];
        warnings: string[];
        summary: {
          ticketCount: number;
          hasDependencies: boolean;
          hasHooks: boolean;
          hasMessaging: boolean;
        };
      } = {
        valid: true,
        errors: [],
        warnings: [],
        summary: {
          ticketCount: 0,
          hasDependencies: false,
          hasHooks: false,
          hasMessaging: false,
        },
      };

      try {
        // Check file exists
        if (!(await fileExists(ticketsPath))) {
          results.valid = false;
          results.errors.push(`File not found: ${ticketsPath}`);

          if (options.json) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.error(chalk.red(`File not found: ${ticketsPath}`));
          }
          process.exit(1);
        }

        // Read and parse
        const content = await readFile(ticketsPath, 'utf-8');
        let parsed: unknown;

        try {
          if (ticketsPath.endsWith('.json')) {
            parsed = JSON.parse(content);
          } else {
            parsed = parseYaml(content);
          }
        } catch (err) {
          results.valid = false;
          results.errors.push(`Parse error: ${err instanceof Error ? err.message : String(err)}`);

          if (options.json) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            console.error(chalk.red(`Parse error: ${err instanceof Error ? err.message : String(err)}`));
          }
          process.exit(1);
        }

        // Validate schema
        const parseResult = safeParseTicketsFile(parsed);

        if (!parseResult.success) {
          results.valid = false;
          for (const issue of parseResult.error.issues) {
            results.errors.push(`${issue.path.join('.')}: ${issue.message}`);
          }
        } else {
          const data = parseResult.data;

          // Validate dependencies
          const depValidation = validateTicketDependencies(data.tickets);
          if (!depValidation.valid) {
            results.valid = false;
            results.errors.push(...depValidation.errors);
          }

          // Gather summary
          results.summary.ticketCount = data.tickets.length;
          results.summary.hasDependencies = data.tickets.some(t => t.dependencies && t.dependencies.length > 0);
          results.summary.hasHooks = !!data.hooks;
          results.summary.hasMessaging = !!data.config.messaging;

          // Check for warnings
          const ids = data.tickets.map(t => t.id);
          const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
          if (duplicateIds.length > 0) {
            results.warnings.push(`Duplicate ticket IDs: ${[...new Set(duplicateIds)].join(', ')}`);
          }

          // Check for tickets with no description
          for (const ticket of data.tickets) {
            if (ticket.description.trim().length < 10) {
              results.warnings.push(`Ticket ${ticket.id} has a very short description`);
            }
          }

          // Check image paths exist
          for (const ticket of data.tickets) {
            if (ticket.images) {
              for (const imgPath of ticket.images) {
                const absPath = resolve(cwd, imgPath);
                if (!(await fileExists(absPath))) {
                  results.warnings.push(`Ticket ${ticket.id}: image not found: ${imgPath}`);
                }
              }
            }
          }
        }

        // Output results
        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          displayValidationResults(results, ticketsPath);
        }

        process.exit(results.valid ? 0 : 1);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.valid = false;
        results.errors.push(message);

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          console.error(chalk.red(`Error: ${message}`));
        }
        process.exit(1);
      }
    });
}

function displayValidationResults(
  results: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    summary: {
      ticketCount: number;
      hasDependencies: boolean;
      hasHooks: boolean;
      hasMessaging: boolean;
    };
  },
  filePath: string
): void {
  console.log('');
  console.log(chalk.bold(`Validating: ${filePath}`));
  console.log(chalk.dim('─'.repeat(50)));

  if (results.valid) {
    console.log(chalk.green.bold('\n\u2714 Valid\n'));
  } else {
    console.log(chalk.red.bold('\n\u2718 Invalid\n'));
  }

  if (results.errors.length > 0) {
    console.log(chalk.red('Errors:'));
    for (const error of results.errors) {
      console.log(chalk.red(`  - ${error}`));
    }
    console.log('');
  }

  if (results.warnings.length > 0) {
    console.log(chalk.yellow('Warnings:'));
    for (const warning of results.warnings) {
      console.log(chalk.yellow(`  - ${warning}`));
    }
    console.log('');
  }

  console.log(chalk.bold('Summary:'));
  console.log(`  Tickets:      ${results.summary.ticketCount}`);
  console.log(`  Dependencies: ${results.summary.hasDependencies ? 'Yes' : 'No'}`);
  console.log(`  Hooks:        ${results.summary.hasHooks ? 'Yes' : 'No'}`);
  console.log(`  Messaging:    ${results.summary.hasMessaging ? 'Configured' : 'No'}`);
  console.log('');
}

// =============================================================================
// Plan Command
// =============================================================================

export function createPlanCommand(): Command {
  return new Command('plan')
    .description('Generate plan for a single ticket (dry run)')
    .argument('<ticket-id>', 'Ticket ID to plan')
    .option('-f, --tickets-file <path>', 'Path to tickets file', 'tickets.yaml')
    .option('-o, --output <path>', 'Save plan to file')
    .action(async (ticketId: string, options: { ticketsFile: string; output?: string }) => {
      const cwd = process.cwd();
      const ticketsPath = resolve(cwd, options.ticketsFile);

      const spinner = ora('Loading tickets...').start();

      try {
        // Load tickets
        if (!(await fileExists(ticketsPath))) {
          spinner.fail(`Tickets file not found: ${ticketsPath}`);
          process.exit(1);
        }

        const content = await readFile(ticketsPath, 'utf-8');
        const parsed = ticketsPath.endsWith('.json')
          ? JSON.parse(content)
          : parseYaml(content);

        const data = parseTicketsFile(parsed);
        const ticket = data.tickets.find(t => t.id === ticketId);

        if (!ticket) {
          spinner.fail(`Ticket not found: ${ticketId}`);
          console.log(chalk.dim('\nAvailable tickets:'));
          for (const t of data.tickets) {
            console.log(chalk.dim(`  - ${t.id}: ${t.title}`));
          }
          process.exit(1);
        }

        spinner.text = `Generating plan for: ${ticket.title}...`;

        // Resolve images if present
        const { resolved: resolvedImagePaths, warnings: imageWarnings } = ticket.images?.length
          ? await resolveAndValidateImages(cwd, ticket.images)
          : { resolved: [] as string[], warnings: [] as string[] };

        // Build prompt
        const prompt = buildPlanPrompt(ticket, resolvedImagePaths, imageWarnings);

        // Generate plan
        const result = await claude.generatePlan(prompt, {
          model: data.config.model,
          timeout: data.config.timeouts.planGeneration,
          cwd,
        });

        if (!result.success || !result.plan) {
          spinner.fail('Plan generation failed');
          console.error(chalk.red(`\nError: ${result.error}`));
          process.exit(1);
        }

        spinner.succeed('Plan generated');

        // Output plan
        console.log('');
        console.log(chalk.bold(`Plan for: ${ticket.title}`));
        console.log(chalk.dim('─'.repeat(60)));
        console.log(result.plan);
        console.log(chalk.dim('─'.repeat(60)));

        if (result.costUsd !== undefined) {
          console.log(chalk.dim(`Cost: $${result.costUsd.toFixed(4)}`));
        }

        // Save to file if requested
        if (options.output) {
          const outputPath = resolve(cwd, options.output);
          await writeFile(outputPath, result.plan, 'utf-8');
          console.log(chalk.green(`\nPlan saved to: ${outputPath}`));
        }

        logger.info('Plan generated via CLI', { ticketId, costUsd: result.costUsd });
      } catch (err) {
        spinner.fail('Failed to generate plan');
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });
}

function buildPlanPrompt(ticket: Ticket, resolvedImagePaths: string[] = [], imageWarnings: string[] = []): string {
  const parts = [
    `# Task: ${ticket.title}`,
    '',
    '## Description',
    ticket.description,
  ];

  if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
    parts.push('', '## Acceptance Criteria');
    for (const criterion of ticket.acceptanceCriteria) {
      parts.push(`- ${criterion}`);
    }
  }

  const imageSection = buildImagePromptSection(resolvedImagePaths, imageWarnings);
  if (imageSection) {
    parts.push('', imageSection);
  }

  parts.push(
    '',
    '## Instructions',
    'Create a detailed implementation plan for this task.',
    'Include:',
    '- Files to create or modify',
    '- Step-by-step implementation approach',
    '- Testing strategy',
    '- Potential risks or considerations',
    '',
    'Do NOT implement yet - only plan.'
  );

  return parts.join('\n');
}

// =============================================================================
// Serve Command
// =============================================================================

export function createServeCommand(): Command {
  return new Command('serve')
    .description('Start webhook server only')
    .option('-p, --port <port>', 'Port to listen on', '3847')
    .option('--path <path>', 'Webhook path', '/planbot/webhook')
    .action(async (options: { port: string; path: string }) => {
      const port = parseInt(options.port, 10);

      console.log('');
      console.log(chalk.bold('Starting webhook server...'));

      try {
        const server = createWebhookServer({
          port,
          path: options.path,
        });

        // Set up callbacks
        server.setCallbacks({
          onApproval: (data) => {
            console.log(chalk.green(`Received approval: ${data.planId} - ${data.approved ? 'Approved' : 'Rejected'}`));
          },
          onQuestionResponse: (data) => {
            console.log(chalk.cyan(`Received answer: ${data.questionId} - ${data.answer}`));
          },
        });

        await server.start();

        console.log(chalk.green(`\nWebhook server listening on port ${port}`));
        console.log(chalk.dim(`Endpoint: http://localhost:${port}${options.path}`));
        console.log(chalk.dim('\nPress Ctrl+C to stop'));

        // Keep alive
        const cleanup = async () => {
          console.log(chalk.yellow('\nShutting down...'));
          await server.stop();
          process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        await new Promise(() => {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed to start server: ${message}`));
        process.exit(1);
      }
    });
}

// =============================================================================
// Reset Command
// =============================================================================

export function createResetCommand(): Command {
  return new Command('reset')
    .description('Reset ticket(s) to pending status')
    .argument('[ticket-id]', 'Ticket ID to reset (resets all if omitted)')
    .option('-f, --tickets-file <path>', 'Path to tickets file', 'tickets.yaml')
    .option('--confirm', 'Skip confirmation prompt')
    .action(async (ticketId: string | undefined, options: { ticketsFile: string; confirm?: boolean }) => {
      const cwd = process.cwd();
      const ticketsPath = resolve(cwd, options.ticketsFile);

      try {
        if (!(await fileExists(ticketsPath))) {
          console.error(chalk.red(`Tickets file not found: ${ticketsPath}`));
          process.exit(1);
        }

        const content = await readFile(ticketsPath, 'utf-8');
        const isJson = ticketsPath.endsWith('.json');
        const parsed = isJson ? JSON.parse(content) : parseYaml(content);
        const data = parseTicketsFile(parsed);

        let ticketsToReset: Ticket[];

        if (ticketId) {
          const ticket = data.tickets.find(t => t.id === ticketId);
          if (!ticket) {
            console.error(chalk.red(`Ticket not found: ${ticketId}`));
            process.exit(1);
          }
          ticketsToReset = [ticket];
        } else {
          ticketsToReset = data.tickets.filter(t => t.status !== 'pending');
        }

        if (ticketsToReset.length === 0) {
          console.log(chalk.yellow('No tickets to reset.'));
          process.exit(0);
        }

        // Confirm
        if (!options.confirm) {
          console.log(chalk.yellow(`\nAbout to reset ${ticketsToReset.length} ticket(s):`));
          for (const t of ticketsToReset) {
            console.log(chalk.dim(`  - ${t.id} (${t.status} -> pending)`));
          }
          console.log(chalk.dim('\nUse --confirm to skip this prompt.'));

          // Simple confirmation via readline
          const readline = await import('node:readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.yellow('\nProceed? [y/N] '), resolve);
          });
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            console.log('Cancelled.');
            process.exit(0);
          }
        }

        // Reset tickets
        for (const ticket of ticketsToReset) {
          ticket.status = 'pending';
        }

        // Write back
        const output = isJson
          ? JSON.stringify(data, null, 2)
          : stringifyYaml(data, { lineWidth: 0 });

        await writeFile(ticketsPath, output, 'utf-8');

        console.log(chalk.green(`\nReset ${ticketsToReset.length} ticket(s) to pending.`));

        logger.info('Tickets reset via CLI', { count: ticketsToReset.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}

// =============================================================================
// Clear Command
// =============================================================================

export function createClearCommand(): Command {
  return new Command('clear')
    .description('Clear all planbot state')
    .option('--confirm', 'Skip confirmation prompt')
    .action(async (options: { confirm?: boolean }) => {
      const cwd = process.cwd();

      try {
        if (!(await stateManager.exists(cwd))) {
          console.log(chalk.yellow('No planbot state to clear.'));
          process.exit(0);
        }

        // Confirm
        if (!options.confirm) {
          console.log(chalk.yellow('\nThis will delete:'));
          console.log(chalk.dim('  - .planbot/state.json'));
          console.log(chalk.dim('  - .planbot/plans/'));
          console.log(chalk.dim('  - .planbot/sessions/'));
          console.log(chalk.dim('  - .planbot/questions/'));
          console.log(chalk.dim('\nUse --confirm to skip this prompt.'));

          const readline = await import('node:readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.yellow('\nProceed? [y/N] '), resolve);
          });
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            console.log('Cancelled.');
            process.exit(0);
          }
        }

        await stateManager.clear(cwd);

        console.log(chalk.green('\nState cleared.'));
        console.log(chalk.dim('Run "planbot start" to begin fresh.'));

        logger.info('State cleared via CLI');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}
