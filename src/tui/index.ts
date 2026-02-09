export async function launchTUI(): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error('Error: TUI requires an interactive terminal.');
    process.exit(1);
  }

  try {
    const React = await import('react');
    const { render } = await import('ink');
    const { App } = await import('./app.js');

    const instance = render(React.createElement(App));
    await instance.waitUntilExit();
  } catch (error) {
    console.error(
      'TUI error:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}
