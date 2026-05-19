import { dirname, join } from 'node:path';

import type { Ticket } from './schemas.js';
import type {
  AgentProvider,
  ExecutionCallbacks,
  StreamEvent,
} from './types/agent-provider.js';
import type { PlanbotPaths } from './state.js';
import { getDebriefPath } from './state.js';
import { writeTextFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// buildDebriefPrompt
// =============================================================================

/**
 * Build a markdown prompt asking the resumed agent to respond with a debrief
 * for the just-completed ticket. The agent must respond with markdown content
 * directly — it must NOT use Write/Edit tools. The orchestrator captures the
 * assistant output and writes the file.
 */
export function buildDebriefPrompt(ticket: Ticket): string {
  return [
    `# Handover debrief for ticket \`${ticket.id}\``,
    ``,
    `Title: ${ticket.title}`,
    ``,
    `You have just finished work on the ticket above in this session.`,
    `Please respond with a concise markdown debrief that summarises the work.`,
    `Respond directly with the markdown content in your reply — do not invoke any tools.`,
    ``,
    `Keep it concise, under 300 words. Use short bullet points.`,
    ``,
    `Cover the following sections in your response:`,
    ``,
    `## Files created or modified`,
    `List the files you created or changed, with a one-line note about each.`,
    ``,
    `## Decisions taken`,
    `Key decisions you made during the work, and the reasoning in one line each.`,
    ``,
    `## Dead ends and approaches tried`,
    `Approaches you attempted but rejected, with a brief reason. Include anything`,
    `that looked promising but did not work out, so future tickets do not retry it.`,
    ``,
    `## Surprises and gotchas`,
    `Anything unexpected you encountered — surprises in the codebase, test`,
    `environment, third-party libraries, or build tooling — that future tickets`,
    `should be aware of.`,
    ``,
    `## Open questions and limitations`,
    `Any open questions, known limitations, or unresolved issues that remain after`,
    `this ticket. Be explicit about what is NOT done.`,
    ``,
  ].join('\n');
}

// =============================================================================
// generateDebrief
// =============================================================================

export interface GenerateDebriefOptions {
  ticket: Ticket;
  sessionId: string;
  provider: AgentProvider;
  cwd: string;
  paths: PlanbotPaths;
  timeout: number;
  verbose?: boolean;
}

export interface GenerateDebriefResult {
  success: boolean;
  path?: string;
  error?: string;
  bytesWritten?: number;
}

/**
 * Generate a handover debrief by resuming the agent's session and capturing
 * the markdown response. The orchestrator writes the file — the agent must
 * respond with markdown content directly.
 */
export async function generateDebrief(
  opts: GenerateDebriefOptions,
): Promise<GenerateDebriefResult> {
  const { ticket, sessionId, provider, cwd, paths, timeout, verbose } = opts;

  // 1. Validate ticket id by reusing the existing helper. paths.root is the
  //    `.planbot/` directory; its parent is the project root.
  let debriefPath: string;
  try {
    const projectRoot = dirname(paths.root);
    debriefPath = getDebriefPath(projectRoot, ticket.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }

  logger.info('handover:start', {
    ticketId: ticket.id,
    sessionId,
  });

  const prompt = buildDebriefPrompt(ticket);

  let accumulated = '';
  const callbacks: ExecutionCallbacks = {
    onEvent: (event: StreamEvent) => {
      if (event.type === 'assistant' && typeof event.message === 'string') {
        accumulated += event.message;
      }
    },
    onQuestion: async () => '',
    onOutput: () => {
      /* no-op — debrief output is captured via assistant events */
    },
  };

  logger.debug('handover:resume', {
    ticketId: ticket.id,
    sessionId,
    promptLength: prompt.length,
  });

  const resumeResult = await provider.resume(
    sessionId,
    prompt,
    { cwd, timeout, verbose },
    callbacks,
  );

  if (resumeResult.success === false) {
    const error = resumeResult.error ?? 'agent execution failed';
    logger.warn('handover:error', {
      ticketId: ticket.id,
      error,
    });
    return { success: false, error };
  }

  const content = accumulated;
  if (content.trim().length === 0) {
    logger.warn('handover:empty', { ticketId: ticket.id });
    return { success: false, error: 'debrief response was empty' };
  }

  logger.debug('handover:received', {
    ticketId: ticket.id,
    contentLength: content.length,
    costUsd: resumeResult.costUsd,
  });

  const bytesWritten = Buffer.byteLength(content, 'utf8');
  await writeTextFile(debriefPath, content);

  logger.info('handover:written', {
    ticketId: ticket.id,
    path: debriefPath,
    bytesWritten,
  });

  return { success: true, path: debriefPath, bytesWritten };
}

// =============================================================================
// buildPriorWorkContext
// =============================================================================

export interface BuildPriorWorkContextOptions {
  completedTicketIds: string[];
  paths: PlanbotPaths;
  ticketsFilePath: string;
  /** 1-based index of the current ticket within the queue. */
  currentTicketIndex: number;
  totalTickets: number;
  /** Maximum number of recent ticket ids to list as pointers. Defaults to 5. */
  maxListed?: number;
}

/**
 * Build a compact pointer-only markdown block describing prior work so the
 * next ticket's agent can locate earlier debriefs without re-reading them all.
 * Returns an empty string when no tickets have been completed yet.
 */
export function buildPriorWorkContext(
  opts: BuildPriorWorkContextOptions,
): string {
  const {
    completedTicketIds,
    paths,
    ticketsFilePath,
    currentTicketIndex,
    totalTickets,
    maxListed = 5,
  } = opts;

  if (completedTicketIds.length === 0) {
    return '';
  }

  const listed =
    completedTicketIds.length > maxListed
      ? completedTicketIds.slice(-maxListed)
      : completedTicketIds.slice();

  const completedCount = completedTicketIds.length;

  const lines: string[] = [];
  lines.push('## Prior work context');
  lines.push('');
  lines.push(
    `This is ticket ${currentTicketIndex} of ${totalTickets}. ${completedCount} earlier ticket(s) finished in this run.`,
  );
  lines.push('');
  lines.push(`Tickets queue: ${ticketsFilePath}`);
  lines.push(`Debriefs directory: ${paths.debriefs}`);
  lines.push('');
  lines.push(
    'Most recent completed tickets (read their debriefs if relevant to your task):',
  );
  for (const id of listed) {
    lines.push(`- ${id}: ${join(paths.debriefs, `${id}.md`)}`);
  }
  lines.push('');
  lines.push(
    'If you need older debriefs, list the debriefs directory and read the ones you need.',
  );

  return lines.join('\n');
}
