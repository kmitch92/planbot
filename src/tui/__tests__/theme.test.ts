import {
  STATUS_ICONS,
  COLORS,
  BOX,
  KEYBINDS,
  getPriorityColor,
} from '../../tui/theme.js';

describe('STATUS_ICONS', () => {
  const expectedStatuses = [
    'pending',
    'planning',
    'awaiting_approval',
    'approved',
    'executing',
    'completed',
    'failed',
    'skipped',
  ] as const;

  it('contains entries for all 8 ticket statuses', () => {
    const keys = Object.keys(STATUS_ICONS);
    expect(keys).toHaveLength(8);
    for (const status of expectedStatuses) {
      expect(STATUS_ICONS).toHaveProperty(status);
    }
  });

  it('each entry has icon and color strings', () => {
    for (const status of expectedStatuses) {
      const entry = STATUS_ICONS[status];
      expect(typeof entry.icon).toBe('string');
      expect(entry.icon.length).toBeGreaterThan(0);
      expect(typeof entry.color).toBe('string');
      expect(entry.color.length).toBeGreaterThan(0);
    }
  });
});

describe('COLORS', () => {
  const expectedKeys = [
    'primary',
    'secondary',
    'success',
    'warning',
    'error',
    'muted',
    'accent',
    'text',
  ] as const;

  it('has all semantic color keys', () => {
    for (const key of expectedKeys) {
      expect(COLORS).toHaveProperty(key);
      expect(typeof COLORS[key]).toBe('string');
    }
  });
});

describe('BOX', () => {
  const expectedKeys = [
    'topLeft',
    'topRight',
    'bottomLeft',
    'bottomRight',
    'horizontal',
    'vertical',
    'teeLeft',
    'teeRight',
  ] as const;

  it('has all box drawing character keys', () => {
    for (const key of expectedKeys) {
      expect(BOX).toHaveProperty(key);
      expect(typeof BOX[key]).toBe('string');
    }
  });
});

describe('KEYBINDS', () => {
  const expectedKeys = [
    'back',
    'select',
    'quit',
    'scrollUp',
    'scrollDown',
    'filter',
    'help',
  ] as const;

  it('has all expected keybind entries', () => {
    for (const key of expectedKeys) {
      expect(KEYBINDS).toHaveProperty(key);
      expect(typeof KEYBINDS[key]).toBe('string');
    }
  });
});

describe('getPriorityColor', () => {
  it('returns gray for priority 0', () => {
    expect(getPriorityColor(0)).toBe('gray');
  });

  it('returns cyan for priority 1', () => {
    expect(getPriorityColor(1)).toBe('cyan');
  });

  it('returns yellow for priority 2', () => {
    expect(getPriorityColor(2)).toBe('yellow');
  });

  it('returns red for priority 3', () => {
    expect(getPriorityColor(3)).toBe('red');
  });

  it('returns red for priority greater than 3', () => {
    expect(getPriorityColor(4)).toBe('red');
    expect(getPriorityColor(10)).toBe('red');
  });

  it('returns gray for negative priority', () => {
    expect(getPriorityColor(-1)).toBe('gray');
    expect(getPriorityColor(-5)).toBe('gray');
  });
});
