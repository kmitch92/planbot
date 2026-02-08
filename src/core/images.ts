import { join, basename, extname } from 'node:path';
import { copyFile } from 'node:fs/promises';
import { fileExists, ensureDir } from '../utils/fs.js';
import { SUPPORTED_IMAGE_EXTENSIONS } from './schemas.js';
import { logger } from '../utils/logger.js';

/**
 * Check whether a file path has a supported image extension.
 * Comparison is case-insensitive.
 */
export function isSupportedImageFormat(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Resolve an array of relative image paths against a project root,
 * validating that each file exists on disk.
 *
 * @returns resolved absolute paths and warning strings for missing files
 */
export async function resolveAndValidateImages(
  projectRoot: string,
  images: string[],
): Promise<{ resolved: string[]; warnings: string[] }> {
  const resolved: string[] = [];
  const warnings: string[] = [];

  for (const imagePath of images) {
    const absolutePath = join(projectRoot, imagePath);
    const exists = await fileExists(absolutePath);

    if (exists) {
      resolved.push(absolutePath);
    } else {
      const warning = `Image not found: ${imagePath}`;
      warnings.push(warning);
      logger.warn(warning, { projectRoot, imagePath });
    }
  }

  return { resolved, warnings };
}

/**
 * Copy a source image into the `.planbot/assets/<ticketId>/` directory.
 *
 * @param projectRoot - Absolute path to the project root
 * @param ticketId - Ticket identifier used as the subdirectory name
 * @param sourcePath - Absolute path to the source image file
 * @returns Relative path from project root to the copied file
 * @throws If the source file does not exist or has an unsupported extension
 */
export async function copyImageToAssets(
  projectRoot: string,
  ticketId: string,
  sourcePath: string,
): Promise<string> {
  const exists = await fileExists(sourcePath);
  if (!exists) {
    throw new Error(`Source image does not exist: ${sourcePath}`);
  }

  if (!isSupportedImageFormat(sourcePath)) {
    throw new Error(
      `Unsupported image format: ${extname(sourcePath)}`,
    );
  }

  const filename = basename(sourcePath);
  const destDir = join(projectRoot, '.planbot', 'assets', ticketId);
  const destPath = join(destDir, filename);

  await ensureDir(destDir);
  await copyFile(sourcePath, destPath);

  const relativePath = join('.planbot', 'assets', ticketId, filename);
  logger.debug('Copied image to assets', {
    sourcePath,
    destPath,
    relativePath,
  });

  return relativePath;
}

/**
 * Build a markdown section that instructs Claude to read attached images.
 *
 * @param absolutePaths - Validated absolute paths to image files
 * @param warnings - Warning strings for images that could not be resolved
 * @returns Markdown string (empty when there are no paths and no warnings)
 */
export function buildImagePromptSection(
  absolutePaths: string[],
  warnings: string[],
): string {
  if (absolutePaths.length === 0 && warnings.length === 0) {
    return '';
  }

  const lines: string[] = [
    '## Attached Images',
  ];

  if (absolutePaths.length > 0) {
    lines.push(
      'The following images are attached to this ticket.',
      'Use the Read tool to view each image file before proceeding.',
      '',
    );
    for (const p of absolutePaths) {
      lines.push(`- ${p}`);
    }
  } else {
    lines.push('No valid images found.');
  }

  if (warnings.length > 0) {
    lines.push('', '**Warnings:**');
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
  }

  return lines.join('\n');
}
