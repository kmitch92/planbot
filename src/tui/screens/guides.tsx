import React, { useState } from 'react';
import { useInput } from 'ink';
import { Layout } from '../components/layout.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { ScrollableText } from '../components/scrollable-text.js';
import { KEYBINDS } from '../theme.js';
import { guide as gettingStarted } from '../guides/getting-started.js';
import { guide as telegramSetup } from '../guides/telegram-setup.js';
import { guide as slackSetup } from '../guides/slack-setup.js';
import { guide as discordSetup } from '../guides/discord-setup.js';
import { guide as webhookSetup } from '../guides/webhook-setup.js';
import { guide as hooksGuide } from '../guides/hooks-guide.js';

interface GuidesProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

interface Guide {
  title: string;
  content: string;
}

type Mode = 'list' | 'viewing';

const GUIDES: Guide[] = [
  gettingStarted,
  telegramSetup,
  slackSetup,
  discordSetup,
  webhookSetup,
  hooksGuide,
];

function Guides({ onNavigate }: GuidesProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('list');
  const [selectedGuide, setSelectedGuide] = useState<Guide | null>(null);

  const handleSelect = (item: MenuItem): void => {
    const guide = GUIDES[Number(item.value)];
    setSelectedGuide(guide ?? null);
    setMode('viewing');
  };

  useInput(
    (input) => {
      if (input === 'b') {
        setMode('list');
        setSelectedGuide(null);
      }
    },
    { isActive: mode === 'viewing' },
  );

  if (mode === 'list') {
    const items: MenuItem[] = GUIDES.map((g, i) => ({
      label: g.title,
      value: String(i),
    }));

    return (
      <Layout title="Guides" keybinds={[KEYBINDS.back, KEYBINDS.select]}>
        <Menu items={items} onSelect={handleSelect} />
      </Layout>
    );
  }

  // mode === 'viewing'
  return (
    <Layout
      title={selectedGuide!.title}
      keybinds={['b Back to list', KEYBINDS.back, KEYBINDS.scrollUp, KEYBINDS.scrollDown]}
    >
      <ScrollableText content={selectedGuide!.content} height={20} active={true} />
    </Layout>
  );
}

export { Guides };
export type { GuidesProps };
