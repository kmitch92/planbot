import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, KEYBINDS } from '../theme.js';

interface LayoutProps {
  title: string;
  children: React.ReactNode;
  keybinds?: string[];
}

function Layout({ title, children, keybinds }: LayoutProps): React.JSX.Element {
  const binds = keybinds ?? [KEYBINDS.back];

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box borderStyle="single" paddingX={1}>
        <Text bold color={COLORS.primary}>
          {title}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {children}
      </Box>

      <Box paddingX={1}>
        <Text color={COLORS.muted}>{binds.join(' \u2502 ')}</Text>
      </Box>
    </Box>
  );
}

export { Layout };
export type { LayoutProps };
