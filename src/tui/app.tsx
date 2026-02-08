import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';

type Screen =
  | 'main-menu'
  | 'dashboard'
  | 'ticket-list'
  | 'ticket-detail'
  | 'ticket-wizard'
  | 'config-editor'
  | 'env-manager'
  | 'guides'
  | 'queue-control'
  | 'logs-viewer';

const SCREEN_LABELS: Record<Screen, string> = {
  'main-menu': 'Main Menu',
  dashboard: 'Dashboard',
  'ticket-list': 'Ticket List',
  'ticket-detail': 'Ticket Detail',
  'ticket-wizard': 'Ticket Wizard',
  'config-editor': 'Config Editor',
  'env-manager': 'Environment Manager',
  guides: 'Guides',
  'queue-control': 'Queue Control',
  'logs-viewer': 'Logs Viewer',
};

const App: React.FC = () => {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>('main-menu');
  const [context, setContext] = useState<Record<string, unknown>>({});

  const navigate = useCallback(
    (s: Screen, ctx?: Record<string, unknown>) => {
      setScreen(s);
      setContext(ctx ?? {});
    },
    [],
  );

  useInput((input, key) => {
    if (key.escape && screen !== 'main-menu') {
      navigate('main-menu');
    }
  });

  const renderScreen = (): React.ReactNode => {
    switch (screen) {
      case 'main-menu':
        return (
          <Box flexDirection="column" padding={1}>
            <Text bold color="cyan">
              Planbot TUI
            </Text>
            <Text>{' '}</Text>
            {(Object.keys(SCREEN_LABELS) as Screen[])
              .filter((s) => s !== 'main-menu')
              .map((s) => (
                <Text key={s} color="white">
                  - {SCREEN_LABELS[s]}
                </Text>
              ))}
            <Text>{' '}</Text>
            <Text dimColor>Press Esc to return here from any screen</Text>
          </Box>
        );
      case 'dashboard':
      case 'ticket-list':
      case 'ticket-detail':
      case 'ticket-wizard':
      case 'config-editor':
      case 'env-manager':
      case 'guides':
      case 'queue-control':
      case 'logs-viewer':
        return (
          <Box flexDirection="column" padding={1}>
            <Text bold color="cyan">
              {SCREEN_LABELS[screen]}
            </Text>
            <Text dimColor>Placeholder - Press Esc to return to main menu</Text>
          </Box>
        );
    }
  };

  return <Box flexDirection="column">{renderScreen()}</Box>;
};

export { App };
