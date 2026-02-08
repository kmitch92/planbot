import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { logger } from "../utils/logger.js";

/**
 * Mark a ticket as complete in the YAML file.
 * Uses yaml Document API to preserve comments and formatting.
 */
export async function markTicketCompleteInFile(
  filePath: string,
  ticketId: string
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const doc = parseDocument(content);

  const tickets = doc.get("tickets");
  if (!tickets || typeof tickets !== "object" || !("items" in tickets)) {
    logger.warn("No tickets array found in file", { filePath });
    return;
  }

  let found = false;
  for (const item of (tickets as any).items) {
    if (item.get("id") === ticketId) {
      item.set("complete", true);
      found = true;
      break;
    }
  }

  if (!found) {
    logger.debug("Ticket not found in file for completion marking", {
      ticketId,
      filePath,
    });
    return;
  }

  await writeFile(filePath, doc.toString(), "utf-8");
  logger.info("Marked ticket complete in file", { ticketId });
}

/**
 * Add an image path to a ticket's images array in the YAML file.
 * Creates the images array if it doesn't exist. Preserves comments and formatting.
 */
export async function addImageToTicketInFile(
  filePath: string,
  ticketId: string,
  imagePath: string
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const doc = parseDocument(content);

  const tickets = doc.get("tickets");
  if (!tickets || typeof tickets !== "object" || !("items" in tickets)) {
    logger.warn("No tickets array found in file", { filePath });
    return;
  }

  let found = false;
  for (const item of (tickets as any).items) {
    if (item.get("id") === ticketId) {
      let images = item.get("images");
      if (!images || typeof images !== "object" || !("items" in images)) {
        // Create new images sequence
        item.set("images", doc.createNode([imagePath]));
      } else {
        // Append to existing sequence
        (images as any).items.push(doc.createNode(imagePath));
      }
      found = true;
      break;
    }
  }

  if (!found) {
    logger.debug("Ticket not found in file for image insertion", {
      ticketId,
      filePath,
    });
    return;
  }

  await writeFile(filePath, doc.toString(), "utf-8");
  logger.info("Added image to ticket in file", { ticketId, imagePath });
}
