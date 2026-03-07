import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';

import { writeTextFile } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { BASIC_TEMPLATE, ADVANCED_TEMPLATE } from './init.js';

// =============================================================================
// Types
// =============================================================================

interface NewOptions {
  simple?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse ticket filename to extract number.
 * Returns 0 for tickets.yaml, N for tickets-N.yaml, or null if not a match.
 */
function parseTicketFilename(filename: string): number | null {
  // Match tickets.yaml exactly
  if (filename === 'tickets.yaml') {
    return 0;
  }

  // Match tickets-N.yaml pattern
  const match = filename.match(/^tickets-(\d+)\.yaml$/);
  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

/**
 * Determine the next tickets filename based on existing files.
 * - No tickets files -> tickets.yaml
 * - tickets.yaml exists -> tickets-1.yaml
 * - Find highest N in tickets-N.yaml -> tickets-(N+1).yaml
 */
function getNextTicketsFilename(existingNumbers: number[]): string {
  if (existingNumbers.length === 0) {
    return 'tickets.yaml';
  }

  const maxNumber = Math.max(...existingNumbers);
  return `tickets-${maxNumber + 1}.yaml`;
}

/**
 * Scan directory for tickets*.yaml files and return their numbers.
 */
async function findTicketFileNumbers(directory: string): Promise<number[]> {
  try {
    const files = await readdir(directory);
    const numbers: number[] = [];

    for (const file of files) {
      const num = parseTicketFilename(file);
      if (num !== null) {
        numbers.push(num);
      }
    }

    return numbers;
  } catch (err) {
    // Directory doesn't exist or can't be read - treat as empty
    logger.debug('Failed to read directory', { directory, error: err });
    return [];
  }
}

// =============================================================================
// Command Implementation
// =============================================================================

export function createNewCommand(): Command {
  return new Command('new')
    .description('Create a new tickets file with incrementing number')
    .option('--simple', 'Use simple template without hooks')
    .action(async (options: NewOptions) => {
      const cwd = process.cwd();

      try {
        // Scan for existing tickets files
        const existingNumbers = await findTicketFileNumbers(cwd);
        logger.debug('Found existing ticket files', { existingNumbers });

        // Determine next filename
        const filename = getNextTicketsFilename(existingNumbers);
        const filePath = join(cwd, filename);

        // Select template
        const template = options.simple ? BASIC_TEMPLATE : ADVANCED_TEMPLATE;

        // Write the file
        await writeTextFile(filePath, template);
        logger.debug('Created tickets file', { filename, simple: options.simple });

        // Output the created filename
        console.log(chalk.green('Created:'), filename);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        logger.error('New command failed', { error: message });
        process.exit(1);
      }
    });
}
