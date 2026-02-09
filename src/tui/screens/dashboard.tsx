import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { Layout } from '../components/layout.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { StatusBadge } from '../components/status-badge.js';
import { useTickets } from '../hooks/use-tickets.js';
import { usePlanbotState } from '../hooks/use-planbot-state.js';
import { COLORS, KEYBINDS } from '../theme.js';

interface DashboardProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

const QUICK_ACTIONS: MenuItem[] = [
  { label: 'Start Processing', value: 'queue-control' },
  { label: 'View Tickets', value: 'ticket-list' },
  { label: 'Create Ticket', value: 'ticket-wizard' },
];

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  if (Number.isNaN(then)) return iso;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Dashboard({ onNavigate }: DashboardProps): React.JSX.Element {
  const { tickets, loading: ticketsLoading, error: ticketsError } = useTickets();
  const { state, loading: stateLoading, error: stateError } = usePlanbotState();

  const loading = ticketsLoading || stateLoading;
  const error = ticketsError ?? stateError;

  if (loading) {
    return (
      <Layout title="Dashboard" keybinds={[KEYBINDS.back]}>
        <Box>
          <Text color={COLORS.primary}>
            <Spinner type="dots" />
          </Text>
          <Text> Loading...</Text>
        </Box>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout title="Dashboard" keybinds={[KEYBINDS.back]}>
        <Text color={COLORS.error}>{error}</Text>
      </Layout>
    );
  }

  const total = tickets.length;
  const pending = tickets.filter((t) => t.status === 'pending').length;
  const completed = tickets.filter((t) => t.status === 'completed').length;
  const failed = tickets.filter((t) => t.status === 'failed').length;

  const handleSelect = (item: MenuItem): void => {
    onNavigate(item.value);
  };

  return (
    <Layout title="Dashboard" keybinds={[KEYBINDS.back, 'ENTER View Ticket']}>
      {/* Queue Summary */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.primary}>
          Queue Summary
        </Text>
        <Box>
          <Text>
            Total: <Text bold>{total}</Text> {'\u2502'}{' '}
            Pending: <Text bold color={COLORS.warning}>{pending}</Text> {'\u2502'}{' '}
            Completed: <Text bold color={COLORS.success}>{completed}</Text> {'\u2502'}{' '}
            Failed: <Text bold color={COLORS.error}>{failed}</Text>
          </Text>
        </Box>
      </Box>

      {/* Current State */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.primary}>
          Current State
        </Text>
        {state ? (
          <Box flexDirection="column">
            <Box>
              <Text>Phase: </Text>
              <StatusBadge status={state.currentPhase} />
            </Box>
            <Text>
              Active Ticket: <Text bold>{state.currentTicketId ?? 'None'}</Text>
            </Text>
            <Text>
              Pending Questions: <Text bold>{state.pendingQuestions.length}</Text>
            </Text>
            <Text>
              Last Updated: <Text dimColor>{formatRelativeTime(state.lastUpdatedAt)}</Text>
            </Text>
          </Box>
        ) : (
          <Text dimColor>No state file found</Text>
        )}
      </Box>

      {/* Quick Actions */}
      <Box flexDirection="column">
        <Text bold color={COLORS.primary}>
          Quick Actions
        </Text>
        <Menu items={QUICK_ACTIONS} onSelect={handleSelect} />
      </Box>
    </Layout>
  );
}

export { Dashboard };
export type { DashboardProps };
