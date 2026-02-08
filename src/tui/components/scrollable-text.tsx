import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ScrollableTextProps {
  content: string;
  height?: number;
  active?: boolean;
}

export function ScrollableText({
  content,
  height = 20,
  active = true,
}: ScrollableTextProps): React.JSX.Element {
  const lines = content.split('\n');
  const maxOffset = Math.max(0, lines.length - height);
  const [scrollOffset, setScrollOffset] = useState(0);

  useInput(
    (input, key) => {
      if (input === 'j' || key.downArrow) {
        setScrollOffset((prev) => Math.min(prev + 1, maxOffset));
      } else if (input === 'k' || key.upArrow) {
        setScrollOffset((prev) => Math.max(prev - 1, 0));
      } else if (input === 'g' && !key.shift) {
        setScrollOffset(0);
      } else if (input === 'G') {
        setScrollOffset(maxOffset);
      }
    },
    { isActive: active },
  );

  const visible = lines.slice(scrollOffset, scrollOffset + height);
  const endLine = Math.min(scrollOffset + height, lines.length);

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <Text key={scrollOffset + i}>{line}</Text>
      ))}
      <Text dimColor>
        Lines {scrollOffset + 1}-{endLine} of {lines.length}
      </Text>
    </Box>
  );
}
