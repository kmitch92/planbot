import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { Layout } from '../components/layout.js';
import { FormWizard, type WizardStep } from '../components/form-wizard.js';
import { TextInputField } from '../components/text-input.js';
import { Confirm } from '../components/confirm.js';
import { useTickets } from '../hooks/use-tickets.js';
import { TicketSchema } from '../../core/schemas.js';
import { COLORS, KEYBINDS } from '../theme.js';

interface TicketWizardProps {
  onNavigate: (screen: string, ctx?: Record<string, unknown>) => void;
}

const WIZARD_STEPS: WizardStep[] = [
  { id: 'id', label: 'ID' },
  { id: 'title', label: 'Title' },
  { id: 'description', label: 'Description' },
  { id: 'priority', label: 'Priority' },
  { id: 'planMode', label: 'Plan Mode' },
  { id: 'criteria', label: 'Criteria' },
  { id: 'review', label: 'Review' },
];

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function TicketWizard({ onNavigate }: TicketWizardProps): React.JSX.Element {
  const { tickets, reload } = useTickets();

  const [step, setStep] = useState(0);
  const [ticketData, setTicketData] = useState({
    id: '',
    title: '',
    description: '',
    priority: '0',
    planMode: true,
    acceptanceCriteria: [] as string[],
  });
  const [currentInput, setCurrentInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    type: 'success' | 'error';
  } | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const advance = useCallback(() => {
    setCurrentInput('');
    clearError();
    setStep((s) => s + 1);
  }, [clearError]);

  const reset = useCallback(() => {
    setStep(0);
    setTicketData({
      id: '',
      title: '',
      description: '',
      priority: '0',
      planMode: true,
      acceptanceCriteria: [],
    });
    setCurrentInput('');
    clearError();
    setMessage(null);
  }, [clearError]);

  // Escape to cancel
  useInput((_input, key) => {
    if (key.escape) {
      onNavigate('main-menu');
    }
  });

  // Any key after success message navigates to ticket list
  useInput(
    () => {
      if (message?.type === 'success') {
        reload();
        onNavigate('ticket-list');
      }
    },
    { isActive: message?.type === 'success' },
  );

  const saveTicket = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      const filePath = 'tickets.yaml';
      const raw = await readFile(filePath, 'utf-8');
      const doc = parseDocument(raw);

      const newTicket: Record<string, unknown> = {
        id: ticketData.id,
        title: ticketData.title,
        description: ticketData.description,
        priority: Number(ticketData.priority),
        status: 'pending',
        planMode: ticketData.planMode,
      };
      if (ticketData.acceptanceCriteria.length > 0) {
        newTicket.acceptanceCriteria = ticketData.acceptanceCriteria;
      }

      const result = TicketSchema.safeParse(newTicket);
      if (!result.success) {
        setError(
          result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        );
        setSaving(false);
        return;
      }

      const ticketsNode = doc.get('tickets', true);
      (ticketsNode as { add: (item: Record<string, unknown>) => void }).add(
        newTicket,
      );
      await writeFile(filePath, doc.toString(), 'utf-8');

      setMessage({ text: `Ticket "${ticketData.id}" created!`, type: 'success' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [ticketData]);

  // --- Step handlers ---

  const handleIdSubmit = useCallback(
    (value: string) => {
      clearError();
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        setError('Ticket ID is required.');
        return;
      }
      if (!ID_PATTERN.test(trimmed)) {
        setError('ID must contain only letters, numbers, hyphens, and underscores.');
        return;
      }
      if (tickets.some((t) => t.id === trimmed)) {
        setError(`Ticket "${trimmed}" already exists.`);
        return;
      }
      setTicketData((prev) => ({ ...prev, id: trimmed }));
      advance();
    },
    [tickets, advance, clearError],
  );

  const handleTitleSubmit = useCallback(
    (value: string) => {
      clearError();
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > 200) {
        setError('Title must be 1-200 characters.');
        return;
      }
      setTicketData((prev) => ({ ...prev, title: trimmed }));
      advance();
    },
    [advance, clearError],
  );

  const handleDescriptionSubmit = useCallback(
    (value: string) => {
      clearError();
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        setError('Description is required.');
        return;
      }
      setTicketData((prev) => ({ ...prev, description: trimmed }));
      advance();
    },
    [advance, clearError],
  );

  const handlePrioritySubmit = useCallback(
    (value: string) => {
      clearError();
      const trimmed = value.trim();
      const num = Number(trimmed);
      if (trimmed.length === 0 || !Number.isInteger(num) || num < 0) {
        setError('Priority must be a non-negative integer.');
        return;
      }
      setTicketData((prev) => ({ ...prev, priority: trimmed }));
      advance();
    },
    [advance, clearError],
  );

  const handlePlanModeConfirm = useCallback(
    (confirmed: boolean) => {
      setTicketData((prev) => ({ ...prev, planMode: confirmed }));
      advance();
    },
    [advance],
  );

  const handleCriterionSubmit = useCallback(
    (value: string) => {
      clearError();
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        // Empty submission = done adding criteria
        advance();
        return;
      }
      setTicketData((prev) => ({
        ...prev,
        acceptanceCriteria: [...prev.acceptanceCriteria, trimmed],
      }));
      setCurrentInput('');
    },
    [advance, clearError],
  );

  const handleReviewConfirm = useCallback(
    (confirmed: boolean) => {
      if (confirmed) {
        void saveTicket();
      } else {
        reset();
      }
    },
    [saveTicket, reset],
  );

  // --- Render ---

  if (message) {
    const color = message.type === 'success' ? COLORS.success : COLORS.error;
    return (
      <Layout title="Create Ticket" keybinds={['Press any key to continue']}>
        <Text color={color}>{message.text}</Text>
      </Layout>
    );
  }

  if (saving) {
    return (
      <Layout title="Create Ticket" keybinds={[KEYBINDS.back]}>
        <Text>
          <Spinner type="dots" /> Saving ticket...
        </Text>
      </Layout>
    );
  }

  const renderStep = (): React.ReactNode => {
    switch (step) {
      case 0:
        return (
          <TextInputField
            label="Ticket ID:"
            value={currentInput}
            onChange={setCurrentInput}
            onSubmit={handleIdSubmit}
            placeholder="feature-001"
            error={error ?? undefined}
          />
        );

      case 1:
        return (
          <TextInputField
            label="Title:"
            value={currentInput}
            onChange={setCurrentInput}
            onSubmit={handleTitleSubmit}
            placeholder="Short descriptive title"
            error={error ?? undefined}
          />
        );

      case 2:
        return (
          <TextInputField
            label="Description:"
            value={currentInput}
            onChange={setCurrentInput}
            onSubmit={handleDescriptionSubmit}
            placeholder="What needs to be done..."
            error={error ?? undefined}
          />
        );

      case 3:
        return (
          <TextInputField
            label="Priority (0 = default):"
            value={currentInput}
            onChange={setCurrentInput}
            onSubmit={handlePrioritySubmit}
            placeholder="0"
            error={error ?? undefined}
          />
        );

      case 4:
        return (
          <Confirm
            message="Generate plan before execution?"
            onConfirm={handlePlanModeConfirm}
            defaultValue={true}
          />
        );

      case 5:
        return (
          <Box flexDirection="column">
            {ticketData.acceptanceCriteria.length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                <Text bold>Criteria:</Text>
                {ticketData.acceptanceCriteria.map((c, i) => (
                  <Text key={i}>
                    {' '}
                    {i + 1}. {c}
                  </Text>
                ))}
              </Box>
            )}
            <TextInputField
              label="Add criterion (empty to finish):"
              value={currentInput}
              onChange={setCurrentInput}
              onSubmit={handleCriterionSubmit}
              placeholder="Describe an acceptance criterion"
              error={error ?? undefined}
            />
          </Box>
        );

      case 6:
        return (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text bold color={COLORS.primary}>
                Ticket Preview
              </Text>
              <Text>
                <Text bold>id:</Text> {ticketData.id}
              </Text>
              <Text>
                <Text bold>title:</Text> {ticketData.title}
              </Text>
              <Text>
                <Text bold>description:</Text> {ticketData.description}
              </Text>
              <Text>
                <Text bold>priority:</Text> {ticketData.priority}
              </Text>
              <Text>
                <Text bold>status:</Text> pending
              </Text>
              <Text>
                <Text bold>planMode:</Text> {String(ticketData.planMode)}
              </Text>
              {ticketData.acceptanceCriteria.length > 0 && (
                <Box flexDirection="column">
                  <Text bold>acceptanceCriteria:</Text>
                  {ticketData.acceptanceCriteria.map((c, i) => (
                    <Text key={i}> - {c}</Text>
                  ))}
                </Box>
              )}
            </Box>
            <Confirm message="Create this ticket?" onConfirm={handleReviewConfirm} />
          </Box>
        );

      default:
        return null;
    }
  };

  return (
    <Layout
      title="Create Ticket"
      keybinds={[KEYBINDS.back, KEYBINDS.select]}
    >
      <FormWizard steps={WIZARD_STEPS} currentStep={step}>
        {renderStep()}
      </FormWizard>

      {error != null && step === 6 && (
        <Box marginTop={1}>
          <Text color={COLORS.error}>{error}</Text>
        </Box>
      )}
    </Layout>
  );
}

export { TicketWizard };
export type { TicketWizardProps };
