import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../hooks/use-tickets.js', () => ({
  useTickets: () => ({
    tickets: [
      { id: 'test-1', title: 'Test Ticket', status: 'pending', priority: 1, description: 'A test', complete: false },
      { id: 'test-2', title: 'Done Ticket', status: 'completed', priority: 0, description: 'Done', complete: true },
    ],
    ticketsFile: null,
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../hooks/use-planbot-state.js', () => ({
  usePlanbotState: () => ({
    state: {
      version: '1.0.0',
      currentTicketId: 'test-1',
      currentPhase: 'executing',
      sessionId: null,
      pauseRequested: false,
      startedAt: '2025-01-01T00:00:00.000Z',
      lastUpdatedAt: '2025-01-01T01:00:00.000Z',
      pendingQuestions: [],
    },
    paths: { root: '.planbot', state: '.planbot/state.json', plans: '.planbot/plans', questions: '.planbot/questions', sessions: '.planbot/sessions' },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../hooks/use-config.js', () => ({
  useConfig: () => ({
    config: {
      maxBudgetPerTicket: 10,
      maxRetries: 3,
      maxPlanRevisions: 3,
      continueOnError: false,
      autoApprove: false,
      planMode: true,
      skipPermissions: false,
      allowShellHooks: false,
      webhook: { enabled: false, port: 3847, path: '/planbot/webhook', cors: false, insecure: false },
      timeouts: { planGeneration: 900000, execution: 1800000, approval: 86400000, question: 3600000 },
    },
    loading: false,
    error: null,
    updateConfig: vi.fn(),
    reload: vi.fn(),
  }),
}));

vi.mock('../hooks/use-env.js', () => ({
  useEnv: () => ({
    vars: [
      { key: 'SLACK_BOT_TOKEN', value: 'xoxb-test-token-1234' },
      { key: 'API_KEY', value: 'sk-abc123' },
    ],
    loading: false,
    error: null,
    addVar: vi.fn(),
    updateVar: vi.fn(),
    removeVar: vi.fn(),
    reload: vi.fn(),
  }),
}));

vi.mock('ink', async () => {
  const actual = await vi.importActual('ink');
  return {
    ...actual,
    useApp: () => ({ exit: vi.fn() }),
  };
});

vi.mock('../../core/state.js', () => ({
  stateManager: {
    load: vi.fn().mockResolvedValue({ currentPhase: 'idle', currentTicketId: null, pendingQuestions: [] }),
    getPaths: vi.fn().mockReturnValue({ root: '.planbot', plans: '.planbot/plans', state: '.planbot/state.json', questions: '.planbot/questions', sessions: '.planbot/sessions' }),
    loadPlan: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  maskToken: (value: string) => {
    if (value.length <= 12) return '***MASKED***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  },
}));

import { MainMenu } from '../screens/main-menu.js';
import { Dashboard } from '../screens/dashboard.js';
import { TicketList } from '../screens/ticket-list.js';
import { ConfigEditor } from '../screens/config-editor.js';
import { EnvManager } from '../screens/env-manager.js';
import { QueueControl } from '../screens/queue-control.js';
import { Guides } from '../screens/guides.js';

describe('MainMenu screen', () => {
  it('renders the Planbot title', () => {
    const { lastFrame, unmount } = render(
      <MainMenu onNavigate={vi.fn()} onExit={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Planbot');
    unmount();
  });

  it('displays all menu items', () => {
    const { lastFrame, unmount } = render(
      <MainMenu onNavigate={vi.fn()} onExit={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Dashboard');
    expect(frame).toContain('Start Processing');
    expect(frame).toContain('List Tickets');
    expect(frame).toContain('Create Ticket');
    expect(frame).toContain('Edit Config');
    expect(frame).toContain('Manage Env Vars');
    expect(frame).toContain('Guides');
    expect(frame).toContain('Exit');
    unmount();
  });

  it('displays keybind hints', () => {
    const { lastFrame, unmount } = render(
      <MainMenu onNavigate={vi.fn()} onExit={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('ENTER Select');
    expect(frame).toContain('q Quit');
    unmount();
  });
});

describe('Dashboard screen', () => {
  it('renders the Dashboard title', () => {
    const { lastFrame, unmount } = render(
      <Dashboard onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Dashboard');
    unmount();
  });

  it('shows queue summary with ticket counts', () => {
    const { lastFrame, unmount } = render(
      <Dashboard onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Queue Summary');
    expect(frame).toContain('Total:');
    expect(frame).toContain('2');
    expect(frame).toContain('Pending:');
    expect(frame).toContain('1');
    expect(frame).toContain('Completed:');
    unmount();
  });

  it('shows current state information', () => {
    const { lastFrame, unmount } = render(
      <Dashboard onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Current State');
    expect(frame).toContain('Phase:');
    expect(frame).toContain('executing');
    expect(frame).toContain('Active Ticket:');
    expect(frame).toContain('test-1');
    unmount();
  });

  it('shows quick actions menu', () => {
    const { lastFrame, unmount } = render(
      <Dashboard onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Quick Actions');
    expect(frame).toContain('Start Processing');
    expect(frame).toContain('View Tickets');
    expect(frame).toContain('Create Ticket');
    unmount();
  });
});

describe('TicketList screen', () => {
  it('renders the Tickets title', () => {
    const { lastFrame, unmount } = render(
      <TicketList onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Tickets');
    unmount();
  });

  it('shows ticket entries', () => {
    const { lastFrame, unmount } = render(
      <TicketList onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('test-1');
    expect(frame).toContain('Test Ticket');
    expect(frame).toContain('test-2');
    expect(frame).toContain('Done Ticket');
    unmount();
  });

  it('shows the filter indicator with default value', () => {
    const { lastFrame, unmount } = render(
      <TicketList onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Filter: all');
    unmount();
  });
});

describe('ConfigEditor screen', () => {
  it('renders the Configuration title', () => {
    const { lastFrame, unmount } = render(
      <ConfigEditor onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Configuration');
    unmount();
  });

  it('shows config fields with current values', () => {
    const { lastFrame, unmount } = render(
      <ConfigEditor onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Max Budget/Ticket: $10');
    expect(frame).toContain('Max Retries: 3');
    expect(frame).toContain('Max Plan Revisions: 3');
    expect(frame).toContain('Continue on Error: false');
    expect(frame).toContain('Auto Approve: false');
    expect(frame).toContain('Plan Mode: true');
    expect(frame).toContain('Allow Shell Hooks: false');
    unmount();
  });
});

describe('EnvManager screen', () => {
  it('renders the Environment Variables title', () => {
    const { lastFrame, unmount } = render(
      <EnvManager onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Environment Variables');
    unmount();
  });

  it('shows variable names', () => {
    const { lastFrame, unmount } = render(
      <EnvManager onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('SLACK_BOT_TOKEN');
    expect(frame).toContain('API_KEY');
    unmount();
  });

  it('shows masked variable values', () => {
    const { lastFrame, unmount } = render(
      <EnvManager onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('xoxb...1234');
    expect(frame).toContain('***MASKED***');
    unmount();
  });

  it('shows action menu items', () => {
    const { lastFrame, unmount } = render(
      <EnvManager onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Add Variable');
    expect(frame).toContain('Edit SLACK_BOT_TOKEN');
    expect(frame).toContain('Edit API_KEY');
    unmount();
  });
});

describe('QueueControl screen', () => {
  it('renders the Start Processing title', () => {
    const { lastFrame, unmount } = render(
      <QueueControl onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Start Processing');
    unmount();
  });

  it('shows flag toggles with default OFF values', () => {
    const { lastFrame, unmount } = render(
      <QueueControl onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Auto Approve: OFF');
    expect(frame).toContain('Dry Run: OFF');
    expect(frame).toContain('Continuous: OFF');
    expect(frame).toContain('Skip Permissions: OFF');
    expect(frame).toContain('Allow Shell Hooks: OFF');
    unmount();
  });

  it('shows the start action', () => {
    const { lastFrame, unmount } = render(
      <QueueControl onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Start');
    unmount();
  });
});

describe('Guides screen', () => {
  it('renders the Guides title', () => {
    const { lastFrame, unmount } = render(
      <Guides onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Guides');
    unmount();
  });

  it('shows guide list items', () => {
    const { lastFrame, unmount } = render(
      <Guides onNavigate={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Getting Started');
    expect(frame).toContain('Telegram');
    expect(frame).toContain('Slack');
    expect(frame).toContain('Discord');
    expect(frame).toContain('Webhook');
    expect(frame).toContain('Hooks');
    unmount();
  });
});

