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
