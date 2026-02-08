import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { Layout } from '../components/layout.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { Confirm } from '../components/confirm.js';
import { KEYBINDS } from '../theme.js';

interface QueueControlProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

interface QueueFlags {
  autoApprove: boolean;
  dryRun: boolean;
  continuous: boolean;
  skipPermissions: boolean;
  allowShellHooks: boolean;
}

type Mode = 'configure' | 'confirm' | 'running';

const DEFAULT_FLAGS: QueueFlags = {
  autoApprove: false,
  dryRun: false,
  continuous: false,
  skipPermissions: false,
  allowShellHooks: false,
};

const FLAG_CLI_MAP: Record<keyof QueueFlags, string> = {
  autoApprove: '--auto-approve',
  dryRun: '--dry-run',
  continuous: '--continuous',
  skipPermissions: '--skip-permissions',
  allowShellHooks: '--allow-shell-hooks',
};

function buildCliCommand(flags: QueueFlags): string {
  const parts = ['planbot start'];
  for (const [key, cliFlag] of Object.entries(FLAG_CLI_MAP)) {
    if (flags[key as keyof QueueFlags]) {
      parts.push(cliFlag);
    }
  }
  return parts.join(' ');
}

function buildMenuItems(flags: QueueFlags): MenuItem[] {
  return [
    { label: `Auto Approve: ${flags.autoApprove ? 'ON' : 'OFF'}`, value: 'autoApprove' },
    { label: `Dry Run: ${flags.dryRun ? 'ON' : 'OFF'}`, value: 'dryRun' },
    { label: `Continuous: ${flags.continuous ? 'ON' : 'OFF'}`, value: 'continuous' },
    { label: `Skip Permissions: ${flags.skipPermissions ? 'ON' : 'OFF'}`, value: 'skipPermissions' },
    { label: `Allow Shell Hooks: ${flags.allowShellHooks ? 'ON' : 'OFF'}`, value: 'allowShellHooks' },
    { label: '\u25B6  Start', value: 'start' },
  ];
}

function buildActiveFlagsSummary(flags: QueueFlags): string[] {
  const active: string[] = [];
  if (flags.autoApprove) active.push('Auto Approve');
  if (flags.dryRun) active.push('Dry Run');
  if (flags.continuous) active.push('Continuous');
  if (flags.skipPermissions) active.push('Skip Permissions');
  if (flags.allowShellHooks) active.push('Allow Shell Hooks');
  return active;
}

function QueueControl({ onNavigate }: QueueControlProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('configure');
  const [flags, setFlags] = useState<QueueFlags>({ ...DEFAULT_FLAGS });

  const handleMenuSelect = useCallback(
    (item: MenuItem) => {
      if (item.value === 'start') {
        setMode('confirm');
        return;
      }

      const key = item.value as keyof QueueFlags;
      setFlags((prev) => ({ ...prev, [key]: !prev[key] }));
    },
    [],
  );

  const handleConfirm = useCallback(
    (confirmed: boolean) => {
      if (confirmed) {
        setMode('running');
      } else {
        setMode('configure');
      }
    },
    [],
  );

  if (mode === 'configure') {
    return (
      <Layout title="Start Processing" keybinds={[KEYBINDS.back, KEYBINDS.select]}>
        <Menu items={buildMenuItems(flags)} onSelect={handleMenuSelect} />
      </Layout>
    );
  }

  if (mode === 'confirm') {
    return (
      <Layout title="Start Processing" keybinds={[KEYBINDS.back]}>
        {flags.skipPermissions && (
          <Box marginBottom={1}>
            <Text color="red">
              {'\u26A0'} Skip Permissions is enabled. Claude will execute without prompting.
            </Text>
          </Box>
        )}
        <Confirm
          message="Start processing with these settings?"
          onConfirm={handleConfirm}
          defaultValue={true}
        />
      </Layout>
    );
  }

  // mode === 'running'
  const activeFlags = buildActiveFlagsSummary(flags);
  const cliCommand = buildCliCommand(flags);

  return (
    <Layout title="Start Processing" keybinds={[KEYBINDS.back]}>
      <Box flexDirection="column">
        <Text bold>Processing started.</Text>
        <Text>Use CLI commands to interact with the running queue.</Text>

        <Box marginTop={1} flexDirection="column">
          <Text bold>Active flags:</Text>
          {activeFlags.length > 0 ? (
            activeFlags.map((flag) => (
              <Text key={flag}>  - {flag}</Text>
            ))
          ) : (
            <Text dimColor>  (none)</Text>
          )}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>Equivalent CLI command:</Text>
          <Text color="cyan">  {cliCommand}</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            Note: Queue processing runs in the foreground. Press Escape to return
            to menu (queue continues in background if started via CLI).
          </Text>
        </Box>
      </Box>
    </Layout>
  );
}

export { QueueControl };
export type { QueueControlProps, QueueFlags };
