import React from 'react';
import { useInput, useApp } from 'ink';
import { Layout } from '../components/layout.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { KEYBINDS } from '../theme.js';

interface MainMenuProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
  onExit: () => void;
}

const MENU_ITEMS: MenuItem[] = [
  { label: '\u{1F4CA}  Dashboard', value: 'dashboard' },
  { label: '\u25B6  Start Processing', value: 'queue-control' },
  { label: '\u{1F4CB}  List Tickets', value: 'ticket-list' },
  { label: '\u271A  Create Ticket', value: 'ticket-wizard' },
  { label: '\u2699  Edit Config', value: 'config-editor' },
  { label: '\u{1F511}  Manage Env Vars', value: 'env-manager' },
  { label: '\u{1F4D6}  Guides', value: 'guides' },
  { label: '\u2715  Exit', value: 'exit' },
];

function MainMenu({ onNavigate, onExit }: MainMenuProps): React.JSX.Element {
  const { exit } = useApp();

  useInput((input) => {
    if (input === 'q') {
      onExit();
      exit();
    }
  });

  const handleSelect = (item: MenuItem): void => {
    if (item.value === 'exit') {
      onExit();
      exit();
    } else {
      onNavigate(item.value);
    }
  };

  return (
    <Layout title="Planbot" keybinds={[KEYBINDS.select, KEYBINDS.quit]}>
      <Menu items={MENU_ITEMS} onSelect={handleSelect} />
    </Layout>
  );
}

export { MainMenu };
export type { MainMenuProps };
