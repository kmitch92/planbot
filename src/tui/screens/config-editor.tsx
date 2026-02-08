import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { Layout } from '../components/layout.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { TextInputField } from '../components/text-input.js';
import { Confirm } from '../components/confirm.js';
import { useConfig } from '../hooks/use-config.js';
import { COLORS, KEYBINDS } from '../theme.js';
import type { Config } from '../../core/schemas.js';

interface ConfigEditorProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

type Mode = 'menu' | 'editing';

interface FeedbackMessage {
  text: string;
  type: 'success' | 'error';
}

const BOOLEAN_FIELDS = new Set<string>([
  'continueOnError',
  'autoApprove',
  'planMode',
  'allowShellHooks',
]);

const NUMBER_FIELDS = new Set<string>([
  'maxBudgetPerTicket',
  'maxRetries',
  'maxPlanRevisions',
]);

const FIELD_LABELS: Record<string, string> = {
  model: 'Model',
  maxBudgetPerTicket: 'Max Budget/Ticket',
  maxRetries: 'Max Retries',
  maxPlanRevisions: 'Max Plan Revisions',
  continueOnError: 'Continue on Error',
  autoApprove: 'Auto Approve',
  planMode: 'Plan Mode',
  allowShellHooks: 'Allow Shell Hooks',
};

const MODEL_ITEMS: MenuItem[] = [
  { label: 'sonnet', value: 'sonnet' },
  { label: 'opus', value: 'opus' },
  { label: 'haiku', value: 'haiku' },
];

function buildMenuItems(config: Config): MenuItem[] {
  return [
    { label: `Model: ${config.model ?? 'default'}`, value: 'model' },
    { label: `Max Budget/Ticket: $${config.maxBudgetPerTicket}`, value: 'maxBudgetPerTicket' },
    { label: `Max Retries: ${config.maxRetries}`, value: 'maxRetries' },
    { label: `Max Plan Revisions: ${config.maxPlanRevisions}`, value: 'maxPlanRevisions' },
    { label: `Continue on Error: ${config.continueOnError}`, value: 'continueOnError' },
    { label: `Auto Approve: ${config.autoApprove}`, value: 'autoApprove' },
    { label: `Plan Mode: ${config.planMode}`, value: 'planMode' },
    { label: `Allow Shell Hooks: ${config.allowShellHooks}`, value: 'allowShellHooks' },
  ];
}

function ConfigEditor({ onNavigate }: ConfigEditorProps): React.JSX.Element {
  const { config, loading, error, updateConfig } = useConfig();

  const [mode, setMode] = useState<Mode>('menu');
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [message, setMessage] = useState<FeedbackMessage | null>(null);

  const resetToMenu = useCallback(() => {
    setMode('menu');
    setEditingField(null);
    setEditValue('');
  }, []);

  const handleMenuSelect = useCallback((item: MenuItem) => {
    setMessage(null);
    setEditingField(item.value);
    setMode('editing');

    if (NUMBER_FIELDS.has(item.value)) {
      setEditValue('');
    }
  }, []);

  const handleUpdateSuccess = useCallback(() => {
    setMessage({ text: 'Configuration updated.', type: 'success' });
    resetToMenu();
  }, [resetToMenu]);

  const handleBooleanConfirm = useCallback(
    async (confirmed: boolean) => {
      if (!editingField) return;
      try {
        await updateConfig({ [editingField]: confirmed } as Partial<Config>);
        handleUpdateSuccess();
      } catch {
        setMessage({ text: error ?? 'Update failed.', type: 'error' });
        resetToMenu();
      }
    },
    [editingField, updateConfig, error, handleUpdateSuccess, resetToMenu],
  );

  const handleModelSelect = useCallback(
    async (item: MenuItem) => {
      try {
        await updateConfig({ model: item.value as Config['model'] });
        handleUpdateSuccess();
      } catch {
        setMessage({ text: error ?? 'Update failed.', type: 'error' });
        resetToMenu();
      }
    },
    [updateConfig, error, handleUpdateSuccess, resetToMenu],
  );

  const handleNumberSubmit = useCallback(
    async (value: string) => {
      if (!editingField) return;

      const num = Number(value);
      if (Number.isNaN(num)) {
        setMessage({ text: 'Invalid number.', type: 'error' });
        resetToMenu();
        return;
      }

      try {
        await updateConfig({ [editingField]: num } as Partial<Config>);
        handleUpdateSuccess();
      } catch {
        setMessage({ text: error ?? 'Update failed.', type: 'error' });
        resetToMenu();
      }
    },
    [editingField, updateConfig, error, handleUpdateSuccess, resetToMenu],
  );

  useInput(
    (_input, key) => {
      if (key.escape && mode === 'editing') {
        resetToMenu();
      }
    },
    { isActive: mode === 'editing' },
  );

  if (loading) {
    return (
      <Layout title="Configuration" keybinds={[KEYBINDS.back]}>
        <Box>
          <Spinner type="dots" />
          <Text> Loading configuration...</Text>
        </Box>
      </Layout>
    );
  }

  if (!config) {
    return (
      <Layout title="Configuration" keybinds={[KEYBINDS.back]}>
        <Text color={COLORS.error}>{error ?? 'Failed to load configuration.'}</Text>
      </Layout>
    );
  }

  const renderEditingField = (): React.ReactNode => {
    if (!editingField) return null;

    const fieldLabel = FIELD_LABELS[editingField] ?? editingField;

    if (BOOLEAN_FIELDS.has(editingField)) {
      return (
        <Confirm
          message={`Enable ${fieldLabel}?`}
          onConfirm={handleBooleanConfirm}
          defaultValue={Boolean(config[editingField as keyof Config])}
        />
      );
    }

    if (editingField === 'model') {
      return (
        <Box flexDirection="column">
          <Text bold>Select model:</Text>
          <Menu items={MODEL_ITEMS} onSelect={handleModelSelect} />
        </Box>
      );
    }

    if (NUMBER_FIELDS.has(editingField)) {
      return (
        <TextInputField
          label={`${fieldLabel}:`}
          value={editValue}
          onChange={setEditValue}
          onSubmit={handleNumberSubmit}
          placeholder={String(config[editingField as keyof Config] ?? '')}
        />
      );
    }

    return null;
  };

  return (
    <Layout title="Configuration" keybinds={[KEYBINDS.back, KEYBINDS.select]}>
      {mode === 'menu' && (
        <Menu items={buildMenuItems(config)} onSelect={handleMenuSelect} />
      )}

      {mode === 'editing' && renderEditingField()}

      {message && (
        <Box marginTop={1}>
          <Text color={message.type === 'success' ? COLORS.success : COLORS.error}>
            {message.text}
          </Text>
        </Box>
      )}

      {error && mode === 'menu' && (
        <Box marginTop={1}>
          <Text color={COLORS.error}>{error}</Text>
        </Box>
      )}
    </Layout>
  );
}

export { ConfigEditor };
export type { ConfigEditorProps };
