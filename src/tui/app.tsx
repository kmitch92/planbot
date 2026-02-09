import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { MainMenu } from './screens/main-menu.js';
import { Dashboard } from './screens/dashboard.js';
import { TicketList } from './screens/ticket-list.js';
import { TicketDetail } from './screens/ticket-detail.js';
import { TicketWizard } from './screens/ticket-wizard.js';
import { ConfigEditor } from './screens/config-editor.js';
import { EnvManager } from './screens/env-manager.js';
import { QueueControl } from './screens/queue-control.js';
import { Guides } from './screens/guides.js';

type Screen =
  | 'main-menu'
  | 'dashboard'
  | 'ticket-list'
  | 'ticket-detail'
  | 'ticket-wizard'
  | 'config-editor'
  | 'env-manager'
  | 'guides'
  | 'queue-control';

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

  const handleNavigate = useCallback(
    (s: string, ctx?: Record<string, unknown>) => {
      navigate(s as Screen, ctx);
    },
    [navigate],
  );

  useInput((input, key) => {
    if (key.escape && screen !== 'main-menu') {
      navigate('main-menu');
    }
  });

  const renderScreen = (): React.ReactNode => {
    switch (screen) {
      case 'main-menu':
        return <MainMenu onNavigate={handleNavigate} onExit={exit} />;
      case 'dashboard':
        return <Dashboard onNavigate={handleNavigate} />;
      case 'ticket-list':
        return <TicketList onNavigate={handleNavigate} />;
      case 'ticket-detail':
        return (
          <TicketDetail
            ticketId={(context.ticketId as string) ?? ''}
            onNavigate={handleNavigate}
          />
        );
      case 'ticket-wizard':
        return <TicketWizard onNavigate={handleNavigate} />;
      case 'config-editor':
        return <ConfigEditor onNavigate={handleNavigate} />;
      case 'env-manager':
        return <EnvManager onNavigate={handleNavigate} />;
      case 'guides':
        return <Guides onNavigate={handleNavigate} />;
      case 'queue-control':
        return <QueueControl onNavigate={handleNavigate} />;
    }
  };

  return <Box flexDirection="column">{renderScreen()}</Box>;
};

export { App };
