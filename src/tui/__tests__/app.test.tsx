import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';

vi.mock('../screens/main-menu.js', () => ({
  MainMenu: ({ onNavigate, onExit }: Record<string, unknown>) => <Text>MAIN_MENU_SCREEN</Text>,
}));

vi.mock('../screens/dashboard.js', () => ({
  Dashboard: () => <Text>DASHBOARD_SCREEN</Text>,
}));

vi.mock('../screens/ticket-list.js', () => ({
  TicketList: () => <Text>TICKET_LIST_SCREEN</Text>,
}));

vi.mock('../screens/ticket-detail.js', () => ({
  TicketDetail: () => <Text>TICKET_DETAIL_SCREEN</Text>,
}));

vi.mock('../screens/ticket-wizard.js', () => ({
  TicketWizard: () => <Text>TICKET_WIZARD_SCREEN</Text>,
}));

vi.mock('../screens/config-editor.js', () => ({
  ConfigEditor: () => <Text>CONFIG_EDITOR_SCREEN</Text>,
}));

vi.mock('../screens/env-manager.js', () => ({
  EnvManager: () => <Text>ENV_MANAGER_SCREEN</Text>,
}));

vi.mock('../screens/queue-control.js', () => ({
  QueueControl: () => <Text>QUEUE_CONTROL_SCREEN</Text>,
}));

vi.mock('../screens/logs-viewer.js', () => ({
  LogsViewer: () => <Text>LOGS_VIEWER_SCREEN</Text>,
}));

vi.mock('../screens/guides.js', () => ({
  Guides: () => <Text>GUIDES_SCREEN</Text>,
}));

vi.mock('ink', async () => {
  const actual = await vi.importActual('ink');
  return {
    ...actual,
    useApp: () => ({ exit: vi.fn() }),
  };
});

import { App } from '../app.js';

describe('App routing', () => {
  it('renders main menu screen by default', () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame();
    expect(frame).toContain('MAIN_MENU_SCREEN');
    unmount();
  });

  it('does not render other screens on initial load', () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame();
    expect(frame).not.toContain('DASHBOARD_SCREEN');
    expect(frame).not.toContain('TICKET_LIST_SCREEN');
    expect(frame).not.toContain('CONFIG_EDITOR_SCREEN');
    expect(frame).not.toContain('ENV_MANAGER_SCREEN');
    expect(frame).not.toContain('QUEUE_CONTROL_SCREEN');
    expect(frame).not.toContain('GUIDES_SCREEN');
    expect(frame).not.toContain('LOGS_VIEWER_SCREEN');
    unmount();
  });
});
