import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.js';

export interface WizardStep {
  id: string;
  label: string;
}

export interface FormWizardProps {
  steps: WizardStep[];
  currentStep: number;
  children: React.ReactNode;
  onCancel?: () => void;
}

export function FormWizard({
  steps,
  currentStep,
  children,
}: FormWizardProps): React.JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        {steps.map((step, index) => {
          const stepNumber = index + 1;

          if (index < currentStep) {
            return (
              <Text key={step.id} color={COLORS.success}>
                {'\u2713'} {stepNumber}. {step.label}
              </Text>
            );
          }

          if (index === currentStep) {
            return (
              <Text key={step.id} bold color={COLORS.primary}>
                {stepNumber}. {step.label}
              </Text>
            );
          }

          return (
            <Text key={step.id} dimColor>
              {stepNumber}. {step.label}
            </Text>
          );
        })}
      </Box>

      <Text dimColor>
        Step {currentStep + 1} of {steps.length}
      </Text>

      {children}
    </Box>
  );
}
