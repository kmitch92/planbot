import { ClaudeProvider } from './claude.js';
import type { AgentProvider } from '../types/agent-provider.js';

const providers: Record<string, () => AgentProvider> = {
  claude: () => new ClaudeProvider(),
};

export function createProvider(name: string): AgentProvider {
  const factory = providers[name];
  if (!factory) {
    throw new Error(`Unknown provider: "${name}". Available: ${Object.keys(providers).join(', ')}`);
  }
  return factory();
}

export { ClaudeProvider } from './claude.js';
