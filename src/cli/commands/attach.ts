import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import {
  parseTicketsFile,
  MAX_IMAGES_PER_TICKET,
} from '../../core/schemas.js';
import { copyImageToAssets } from '../../core/images.js';
import { addImageToTicketInFile } from '../../core/tickets-io.js';
import { isSupportedImageFormat } from '../../core/images.js';
import { fileExists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

export function createAttachCommand(): Command {
  return new Command('attach')
    .description('Attach an image to a ticket')
    .argument('<ticket-id>', 'Ticket ID to attach image to')
    .argument('<image-path>', 'Path to image file')
    .option('-f, --tickets-file <path>', 'Path to tickets file', 'tickets.yaml')
    .action(async (ticketId: string, imagePath: string, options: { ticketsFile: string }) => {
      const cwd = process.cwd();
      const ticketsPath = resolve(cwd, options.ticketsFile);
      const resolvedImagePath = resolve(cwd, imagePath);

      try {
        // Validate tickets file exists
        if (!(await fileExists(ticketsPath))) {
          console.error(chalk.red(`Tickets file not found: ${ticketsPath}`));
          process.exit(1);
        }

        // Parse tickets file
        const content = await readFile(ticketsPath, 'utf-8');
        const parsed = ticketsPath.endsWith('.json')
          ? JSON.parse(content)
          : parseYaml(content);
        const data = parseTicketsFile(parsed);

        // Validate ticket exists
        const ticket = data.tickets.find(t => t.id === ticketId);
        if (!ticket) {
          console.error(chalk.red(`Ticket not found: ${ticketId}`));
          console.log(chalk.dim('\nAvailable tickets:'));
          for (const t of data.tickets) {
            console.log(chalk.dim(`  - ${t.id}: ${t.title}`));
          }
          process.exit(1);
        }

        // Validate image file exists
        if (!(await fileExists(resolvedImagePath))) {
          console.error(chalk.red(`Image file not found: ${resolvedImagePath}`));
          process.exit(1);
        }

        // Validate image format
        if (!isSupportedImageFormat(resolvedImagePath)) {
          console.error(chalk.red(`Unsupported image format: ${imagePath}`));
          console.log(chalk.dim('\nSupported formats: png, jpg, jpeg, gif, webp, svg, bmp, tiff'));
          process.exit(1);
        }

        // Check image count limit
        const currentCount = ticket.images?.length ?? 0;
        if (currentCount >= MAX_IMAGES_PER_TICKET) {
          console.error(chalk.red(`Ticket already has ${currentCount} images (max: ${MAX_IMAGES_PER_TICKET})`));
          process.exit(1);
        }

        // Copy image to assets directory
        const relativePath = await copyImageToAssets(cwd, ticketId, resolvedImagePath);

        // Update YAML file
        await addImageToTicketInFile(ticketsPath, ticketId, relativePath);

        console.log(chalk.green(`\nImage attached to ticket: ${ticketId}`));
        console.log(chalk.dim(`  Source: ${resolvedImagePath}`));
        console.log(chalk.dim(`  Stored: ${relativePath}`));

        logger.info('Image attached via CLI', { ticketId, imagePath: relativePath });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });
}
