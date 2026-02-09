import React, { useState, useCallback } from 'react';
import { Text, useInput } from 'ink';

interface ConfirmProps {
  message: string;
  onConfirm: (confirmed: boolean) => void;
  defaultValue?: boolean;
}

function Confirm({
  message,
  onConfirm,
  defaultValue = true,
}: ConfirmProps): React.JSX.Element | null {
  const [answered, setAnswered] = useState(false);

  const respond = useCallback(
    (value: boolean) => {
      if (answered) return;
      setAnswered(true);
      onConfirm(value);
    },
    [answered, onConfirm],
  );

  useInput(
    (input, key) => {
      if (answered) return;

      if (input === 'y' || input === 'Y') {
        respond(true);
      } else if (input === 'n' || input === 'N') {
        respond(false);
      } else if (key.return) {
        respond(defaultValue);
      }
    },
    { isActive: !answered },
  );

  if (answered) return null;

  const hint = defaultValue ? '[Y/n]' : '[y/N]';

  return (
    <Text>
      {message} <Text color="cyan">{hint}</Text>
    </Text>
  );
}

export { Confirm };
export type { ConfirmProps };
