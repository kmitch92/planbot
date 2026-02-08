import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { Layout } from '../components/layout.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { STATUS_ICONS, KEYBINDS } from '../theme.js';
import { useTickets } from '../hooks/use-tickets.js';

const FILTER_CYCLE = ['all', 'pending', 'completed', 'failed', 'skipped'] as const;
type FilterValue = (typeof FILTER_CYCLE)[number];

interface TicketListProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

function TicketList({ onNavigate }: TicketListProps): React.JSX.Element {
  const { tickets, loading } = useTickets();
  const [statusFilter, setStatusFilter] = useState<FilterValue>('all');

  useInput((input) => {
    if (input === 'f') {
      setStatusFilter((prev) => {
        const idx = FILTER_CYCLE.indexOf(prev);
        return FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length];
      });
    }
  });

  const filtered =
    statusFilter === 'all'
      ? tickets
      : tickets.filter((t) => t.status === statusFilter);

  const items: MenuItem[] = filtered.map((t) => ({
    label: `${STATUS_ICONS[t.status as keyof typeof STATUS_ICONS]?.icon ?? '?'} ${t.id} — ${t.title}`,
    value: t.id,
  }));

  const handleSelect = (item: MenuItem): void => {
    onNavigate('ticket-detail', { ticketId: item.value });
  };

  return (
    <Layout
      title="Tickets"
      keybinds={[KEYBINDS.back, KEYBINDS.select, KEYBINDS.filter]}
    >
      <Text dimColor>Filter: {statusFilter}</Text>
      {loading ? (
        <Text>
          <Spinner type="dots" /> Loading tickets...
        </Text>
      ) : filtered.length === 0 ? (
        <Text dimColor>No tickets found</Text>
      ) : (
        <Menu items={items} onSelect={handleSelect} />
      )}
    </Layout>
  );
}

export { TicketList };
export type { TicketListProps };
