import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Layout } from '../components/layout.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { ScrollableText } from '../components/scrollable-text.js';
import { useTickets } from '../hooks/use-tickets.js';
import { stateManager } from '../../core/state.js';
import { KEYBINDS } from '../theme.js';

interface LogsViewerProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

type Mode = 'select' | 'viewing';

async function loadLog(ticketId: string): Promise<string> {
  const paths = stateManager.getPaths(process.cwd());
  const logPath = join(paths.logs, `${ticketId}.log`);
  return readFile(logPath, 'utf-8');
}

function LogsViewer({ onNavigate }: LogsViewerProps): React.JSX.Element {
  const { tickets, loading } = useTickets();
  const [mode, setMode] = useState<Mode>('select');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  const handleSelect = useCallback((item: MenuItem) => {
    setSelectedTicketId(item.value);
    setLogLoading(true);
    setLogError(null);
    setLogContent('');
    setMode('viewing');
  }, []);

  useEffect(() => {
    if (!selectedTicketId || !logLoading) return;

    let cancelled = false;

    async function fetch(): Promise<void> {
      try {
        const content = await loadLog(selectedTicketId!);
        if (!cancelled) {
          setLogContent(content);
          setLogLoading(false);
        }
      } catch {
        if (!cancelled) {
          setLogError('No logs found for this ticket');
          setLogLoading(false);
        }
      }
    }

    void fetch();

    return () => {
      cancelled = true;
    };
  }, [selectedTicketId, logLoading]);

  useInput(
    (input) => {
      if (input === 'b' && mode === 'viewing') {
        setMode('select');
        setSelectedTicketId(null);
        setLogContent('');
        setLogError(null);
      }
    },
    { isActive: mode === 'viewing' },
  );

  if (mode === 'select') {
    const items: MenuItem[] = tickets.map((t) => ({
      label: `${t.id} \u2014 ${t.title}`,
      value: t.id,
    }));

    return (
      <Layout title="Logs" keybinds={[KEYBINDS.back, KEYBINDS.select]}>
        {loading ? (
          <Text>
            <Spinner type="dots" /> Loading tickets...
          </Text>
        ) : items.length === 0 ? (
          <Text dimColor>No tickets found</Text>
        ) : (
          <Menu items={items} onSelect={handleSelect} />
        )}
      </Layout>
    );
  }

  // mode === 'viewing'
  return (
    <Layout
      title={`Logs: ${selectedTicketId}`}
      keybinds={['b Back to list', KEYBINDS.back, KEYBINDS.scrollUp, KEYBINDS.scrollDown]}
    >
      {logLoading ? (
        <Box>
          <Spinner type="dots" />
          <Text> Loading log...</Text>
        </Box>
      ) : logError ? (
        <Text dimColor>{logError}</Text>
      ) : (
        <ScrollableText content={logContent} height={20} active={true} />
      )}
    </Layout>
  );
}

export { LogsViewer };
export type { LogsViewerProps };
