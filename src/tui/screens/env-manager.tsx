import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { Layout } from '../components/layout.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { TextInputField } from '../components/text-input.js';
import { Confirm } from '../components/confirm.js';
import { useEnv } from '../hooks/use-env.js';
import { COLORS, KEYBINDS } from '../theme.js';
import { maskToken } from '../../utils/logger.js';

interface EnvManagerProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

type Mode = 'list' | 'add-key' | 'add-value' | 'edit' | 'confirm-delete';

interface FeedbackMessage {
  text: string;
  type: 'success' | 'error';
}

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function EnvManager({ onNavigate }: EnvManagerProps): React.JSX.Element {
  const { vars, loading, error, addVar, updateVar, removeVar } = useEnv();

  const [mode, setMode] = useState<Mode>('list');
  const [selectedVar, setSelectedVar] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [keyError, setKeyError] = useState<string | undefined>();
  const [message, setMessage] = useState<FeedbackMessage | null>(null);

  const resetToList = useCallback(() => {
    setMode('list');
    setSelectedVar(null);
    setNewKey('');
    setNewValue('');
    setKeyError(undefined);
  }, []);

  const handleActionSelect = useCallback(
    (item: MenuItem) => {
      setMessage(null);

      if (item.value === 'add') {
        setMode('add-key');
        return;
      }

      if (item.value.startsWith('edit:')) {
        const key = item.value.slice(5);
        setSelectedVar(key);
        const existing = vars.find((v) => v.key === key);
        setNewValue(existing?.value ?? '');
        setMode('edit');
        return;
      }

      if (item.value.startsWith('remove:')) {
        const key = item.value.slice(7);
        setSelectedVar(key);
        setMode('confirm-delete');
      }
    },
    [vars],
  );

  const handleKeySubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!KEY_PATTERN.test(trimmed)) {
      setKeyError('Key must be UPPERCASE with underscores (e.g. MY_VAR)');
      return;
    }
    setKeyError(undefined);
    setNewKey(trimmed);
    setMode('add-value');
  }, []);

  const handleAddValueSubmit = useCallback(
    async (value: string) => {
      try {
        await addVar(newKey, value);
        setMessage({ text: `Added ${newKey}.`, type: 'success' });
        resetToList();
      } catch {
        setMessage({ text: error ?? 'Failed to add variable.', type: 'error' });
        resetToList();
      }
    },
    [newKey, addVar, error, resetToList],
  );

  const handleEditSubmit = useCallback(
    async (value: string) => {
      if (!selectedVar) return;
      try {
        await updateVar(selectedVar, value);
        setMessage({ text: `Updated ${selectedVar}.`, type: 'success' });
        resetToList();
      } catch {
        setMessage({ text: error ?? 'Failed to update variable.', type: 'error' });
        resetToList();
      }
    },
    [selectedVar, updateVar, error, resetToList],
  );

  const handleDeleteConfirm = useCallback(
    async (confirmed: boolean) => {
      if (!selectedVar) {
        resetToList();
        return;
      }

      if (!confirmed) {
        resetToList();
        return;
      }

      try {
        await removeVar(selectedVar);
        setMessage({ text: `Removed ${selectedVar}.`, type: 'success' });
        resetToList();
      } catch {
        setMessage({ text: error ?? 'Failed to remove variable.', type: 'error' });
        resetToList();
      }
    },
    [selectedVar, removeVar, error, resetToList],
  );

  useInput(
    (_input, key) => {
      if (key.escape && mode !== 'list') {
        resetToList();
      }
    },
    { isActive: mode !== 'list' },
  );

  if (loading) {
    return (
      <Layout title="Environment Variables" keybinds={[KEYBINDS.back]}>
        <Box>
          <Spinner type="dots" />
          <Text> Loading environment variables...</Text>
        </Box>
      </Layout>
    );
  }

  const actions: MenuItem[] = [
    { label: 'Add Variable', value: 'add' },
    ...vars.map((v) => ({ label: `Edit ${v.key}`, value: `edit:${v.key}` })),
    ...vars.map((v) => ({ label: `Remove ${v.key}`, value: `remove:${v.key}` })),
  ];

  const renderMode = (): React.ReactNode => {
    switch (mode) {
      case 'list':
        return (
          <>
            {vars.length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                {vars.map((v) => (
                  <Text key={v.key}>
                    <Text bold color={COLORS.primary}>{v.key}</Text>
                    <Text color={COLORS.muted}> = </Text>
                    <Text>{maskToken(v.value)}</Text>
                  </Text>
                ))}
              </Box>
            )}
            {vars.length === 0 && (
              <Box marginBottom={1}>
                <Text color={COLORS.muted}>No environment variables found.</Text>
              </Box>
            )}
            <Menu items={actions} onSelect={handleActionSelect} />
          </>
        );

      case 'add-key':
        return (
          <TextInputField
            label="Variable name:"
            value={newKey}
            onChange={setNewKey}
            onSubmit={handleKeySubmit}
            placeholder="MY_API_KEY"
            error={keyError}
          />
        );

      case 'add-value':
        return (
          <TextInputField
            label={`Value for ${newKey}:`}
            value={newValue}
            onChange={setNewValue}
            onSubmit={handleAddValueSubmit}
          />
        );

      case 'edit':
        return (
          <TextInputField
            label={`New value for ${selectedVar}:`}
            value={newValue}
            onChange={setNewValue}
            onSubmit={handleEditSubmit}
          />
        );

      case 'confirm-delete':
        return (
          <Confirm
            message={`Delete ${selectedVar}?`}
            onConfirm={handleDeleteConfirm}
            defaultValue={false}
          />
        );
    }
  };

  return (
    <Layout
      title="Environment Variables"
      keybinds={[KEYBINDS.back, KEYBINDS.select]}
    >
      {renderMode()}

      {message && (
        <Box marginTop={1}>
          <Text color={message.type === 'success' ? COLORS.success : COLORS.error}>
            {message.text}
          </Text>
        </Box>
      )}

      {error && mode === 'list' && (
        <Box marginTop={1}>
          <Text color={COLORS.error}>{error}</Text>
        </Box>
      )}
    </Layout>
  );
}

export { EnvManager };
export type { EnvManagerProps };
