import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export interface TextInputFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  error?: string;
}

export function TextInputField({
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  error,
}: TextInputFieldProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
      />
      {error != null && <Text color="red">{error}</Text>}
    </Box>
  );
}
