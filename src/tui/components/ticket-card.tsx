import React from 'react';
import { Box, Text } from 'ink';
import { StatusBadge } from './status-badge.js';
import { getPriorityColor, COLORS } from '../theme.js';

export interface TicketCardProps {
  id: string;
  title: string;
  status: string;
  priority: number;
  isSelected?: boolean;
}

export function TicketCard({
  id,
  title,
  status,
  priority,
  isSelected = false,
}: TicketCardProps): React.JSX.Element {
  return (
    <Box gap={1}>
      <Text color={isSelected ? COLORS.primary : undefined}>
        {isSelected ? '>' : ' '}
      </Text>
      <StatusBadge status={status} />
      <Text bold>{id}</Text>
      <Text wrap="truncate">{title}</Text>
      {priority > 0 && (
        <Text color={getPriorityColor(priority)}>P{priority}</Text>
      )}
    </Box>
  );
}
