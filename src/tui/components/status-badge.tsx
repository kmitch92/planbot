import React from 'react';
import { Text } from 'ink';
import { STATUS_ICONS } from '../theme.js';

interface StatusBadgeProps {
  status: string;
}

function StatusBadge({ status }: StatusBadgeProps): React.JSX.Element {
  const entry = STATUS_ICONS[status as keyof typeof STATUS_ICONS];

  if (!entry) {
    return <Text color="gray">? {status}</Text>;
  }

  return (
    <Text color={entry.color}>
      {entry.icon} {status}
    </Text>
  );
}

export { StatusBadge };
export type { StatusBadgeProps };
