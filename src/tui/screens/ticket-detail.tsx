import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { Layout } from '../components/layout.js';
import { StatusBadge } from '../components/status-badge.js';
import { ScrollableText } from '../components/scrollable-text.js';
import { KEYBINDS, getPriorityColor } from '../theme.js';
import { useTickets } from '../hooks/use-tickets.js';
import { stateManager } from '../../core/state.js';

interface TicketDetailProps {
  ticketId: string;
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

function TicketDetail({ ticketId, onNavigate }: TicketDetailProps): React.JSX.Element {
  const { tickets, loading } = useTickets();
  const [plan, setPlan] = useState<string | null>(null);

  useEffect(() => {
    stateManager
      .loadPlan(process.cwd(), ticketId)
      .then((p) => setPlan(p))
      .catch(() => {});
  }, [ticketId]);

  if (loading) {
    return (
      <Layout
        title={`Ticket: ${ticketId}`}
        keybinds={[KEYBINDS.back, KEYBINDS.scrollDown, KEYBINDS.scrollUp]}
      >
        <Text>
          <Spinner type="dots" /> Loading...
        </Text>
      </Layout>
    );
  }

  const ticket = tickets.find((t) => t.id === ticketId);

  if (!ticket) {
    return (
      <Layout
        title={`Ticket: ${ticketId}`}
        keybinds={[KEYBINDS.back]}
      >
        <Text color="red">Ticket not found: {ticketId}</Text>
      </Layout>
    );
  }

  const sections: string[] = [];

  // Description
  sections.push(ticket.description);

  // Acceptance Criteria
  if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
    sections.push('');
    sections.push('--- Acceptance Criteria ---');
    ticket.acceptanceCriteria.forEach((criterion, i) => {
      sections.push(`  ${i + 1}. ${criterion}`);
    });
  }

  // Dependencies
  if (ticket.dependencies && ticket.dependencies.length > 0) {
    sections.push('');
    sections.push(`--- Dependencies ---`);
    sections.push(`  ${ticket.dependencies.join(', ')}`);
  }

  // Plan
  if (plan) {
    sections.push('');
    sections.push('--- Plan ---');
    sections.push(plan);
  }

  // Metadata
  if (ticket.metadata && Object.keys(ticket.metadata).length > 0) {
    sections.push('');
    sections.push('--- Metadata ---');
    sections.push(JSON.stringify(ticket.metadata, null, 2));
  }

  const content = sections.join('\n');

  return (
    <Layout
      title={`Ticket: ${ticketId}`}
      keybinds={[KEYBINDS.back, KEYBINDS.scrollDown, KEYBINDS.scrollUp]}
    >
      <Box gap={1} marginBottom={1}>
        <StatusBadge status={ticket.status} />
        <Text bold>{ticket.title}</Text>
        <Text color={getPriorityColor(ticket.priority)}>P{ticket.priority}</Text>
      </Box>
      <ScrollableText content={content} />
    </Layout>
  );
}

export { TicketDetail };
export type { TicketDetailProps };
