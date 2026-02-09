import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { Layout } from '../components/layout.js';
import { StatusBadge } from '../components/status-badge.js';
import { Confirm } from '../components/confirm.js';
import { ScrollableText } from '../components/scrollable-text.js';
import { FormWizard } from '../components/form-wizard.js';
import { TicketCard } from '../components/ticket-card.js';
import { Menu } from '../components/menu.js';
import { TextInputField } from '../components/text-input.js';

describe('Layout', () => {
  it('renders title text', () => {
    const { lastFrame } = render(
      <Layout title="Test Title">
        <Text>body</Text>
      </Layout>,
    );
    expect(lastFrame()).toContain('Test Title');
  });

  it('renders children content', () => {
    const { lastFrame } = render(
      <Layout title="T">
        <Text>Child Content Here</Text>
      </Layout>,
    );
    expect(lastFrame()).toContain('Child Content Here');
  });

  it('shows default keybind ESC Back when none provided', () => {
    const { lastFrame } = render(
      <Layout title="T">
        <Text>x</Text>
      </Layout>,
    );
    expect(lastFrame()).toContain('ESC Back');
  });

  it('shows custom keybinds when provided', () => {
    const { lastFrame } = render(
      <Layout title="T" keybinds={['ENTER Save', 'q Quit']}>
        <Text>x</Text>
      </Layout>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('ENTER Save');
    expect(frame).toContain('q Quit');
    expect(frame).not.toContain('ESC Back');
  });
});

describe('StatusBadge', () => {
  it('renders known status icon and text for completed', () => {
    const { lastFrame } = render(<StatusBadge status="completed" />);
    const frame = lastFrame()!;
    expect(frame).toContain('\u2713');
    expect(frame).toContain('completed');
  });

  it('renders known status icon and text for pending', () => {
    const { lastFrame } = render(<StatusBadge status="pending" />);
    const frame = lastFrame()!;
    expect(frame).toContain('\u25CB');
    expect(frame).toContain('pending');
  });

  it('renders fallback ? for unknown status', () => {
    const { lastFrame } = render(<StatusBadge status="unknown_status" />);
    const frame = lastFrame()!;
    expect(frame).toContain('?');
    expect(frame).toContain('unknown_status');
  });
});

describe('Confirm', () => {
  it('renders message and [Y/n] hint by default', () => {
    const { lastFrame } = render(
      <Confirm message="Continue?" onConfirm={() => {}} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Continue?');
    expect(frame).toContain('[Y/n]');
  });

  it('renders [y/N] hint when defaultValue is false', () => {
    const { lastFrame } = render(
      <Confirm
        message="Are you sure?"
        onConfirm={() => {}}
        defaultValue={false}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Are you sure?');
    expect(frame).toContain('[y/N]');
  });
});

describe('ScrollableText', () => {
  it('renders visible lines from content', () => {
    const content = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join(
      '\n',
    );
    const { lastFrame } = render(<ScrollableText content={content} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Line 1');
    expect(frame).toContain('Line 20');
    expect(frame).not.toContain('Line 21');
  });

  it('shows line count indicator', () => {
    const content = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join(
      '\n',
    );
    const { lastFrame } = render(<ScrollableText content={content} />);
    expect(lastFrame()).toContain('Lines 1-20 of 30');
  });

  it('shows all lines when content is shorter than height', () => {
    const content = 'Short line 1\nShort line 2\nShort line 3';
    const { lastFrame } = render(
      <ScrollableText content={content} height={10} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Short line 1');
    expect(frame).toContain('Short line 2');
    expect(frame).toContain('Short line 3');
    expect(frame).toContain('Lines 1-3 of 3');
  });
});

describe('FormWizard', () => {
  const steps = [
    { id: 'name', label: 'Name' },
    { id: 'desc', label: 'Description' },
    { id: 'review', label: 'Review' },
  ];

  it('renders step labels', () => {
    const { lastFrame } = render(
      <FormWizard steps={steps} currentStep={0}>
        <Text>form body</Text>
      </FormWizard>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Name');
    expect(frame).toContain('Description');
    expect(frame).toContain('Review');
  });

  it('shows current step number text', () => {
    const { lastFrame } = render(
      <FormWizard steps={steps} currentStep={1}>
        <Text>form body</Text>
      </FormWizard>,
    );
    expect(lastFrame()).toContain('Step 2 of 3');
  });

  it('shows completed steps with checkmark', () => {
    const { lastFrame } = render(
      <FormWizard steps={steps} currentStep={2}>
        <Text>form body</Text>
      </FormWizard>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('\u2713');
    expect(frame).toContain('Step 3 of 3');
  });

  it('renders children content', () => {
    const { lastFrame } = render(
      <FormWizard steps={steps} currentStep={0}>
        <Text>Wizard Child Content</Text>
      </FormWizard>,
    );
    expect(lastFrame()).toContain('Wizard Child Content');
  });
});

describe('TicketCard', () => {
  it('renders ticket ID and title', () => {
    const { lastFrame } = render(
      <TicketCard
        id="TICKET-001"
        title="Fix the bug"
        status="pending"
        priority={1}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('TICKET-001');
    expect(frame).toContain('Fix the bug');
  });

  it('shows selection indicator when isSelected is true', () => {
    const { lastFrame } = render(
      <TicketCard
        id="T-1"
        title="Selected task"
        status="pending"
        priority={0}
        isSelected={true}
      />,
    );
    expect(lastFrame()).toContain('>');
  });

  it('does not show selection indicator when isSelected is false', () => {
    const { lastFrame } = render(
      <TicketCard
        id="T-2"
        title="Not selected"
        status="pending"
        priority={0}
        isSelected={false}
      />,
    );
    const frame = lastFrame()!;
    const lines = frame.split('\n');
    const hasArrow = lines.some((line) => line.includes('>'));
    expect(hasArrow).toBe(false);
  });

  it('shows priority badge when priority > 0', () => {
    const { lastFrame } = render(
      <TicketCard
        id="T-3"
        title="High priority"
        status="executing"
        priority={2}
      />,
    );
    expect(lastFrame()).toContain('P2');
  });

  it('omits priority badge when priority is 0', () => {
    const { lastFrame } = render(
      <TicketCard
        id="T-4"
        title="No priority"
        status="completed"
        priority={0}
      />,
    );
    expect(lastFrame()).not.toContain('P0');
  });
});

describe('Menu', () => {
  it('renders menu items', () => {
    const items = [
      { label: 'Dashboard', value: 'dashboard' },
      { label: 'Settings', value: 'settings' },
      { label: 'Logout', value: 'logout' },
    ];
    const { lastFrame } = render(
      <Menu items={items} onSelect={() => {}} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Dashboard');
    expect(frame).toContain('Settings');
    expect(frame).toContain('Logout');
  });
});

describe('TextInputField', () => {
  it('renders label', () => {
    const { lastFrame } = render(
      <TextInputField
        label="Project Name"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(lastFrame()).toContain('Project Name');
  });

  it('shows error message when error prop is provided', () => {
    const { lastFrame } = render(
      <TextInputField
        label="Email"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        error="Invalid email address"
      />,
    );
    expect(lastFrame()).toContain('Invalid email address');
  });

  it('does not show error when error is undefined', () => {
    const { lastFrame } = render(
      <TextInputField
        label="Name"
        value="Alice"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Name');
    expect(frame).not.toContain('Invalid');
    expect(frame).not.toContain('error');
  });
});
