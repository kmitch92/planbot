/**
 * Backward-compatible shim for src/core/claude.ts
 *
 * The full implementation now lives in src/core/providers/claude.ts.
 * This module re-exports everything with the original names so that
 * all existing imports and test mocks continue to work unchanged.
 */
import { ClaudeProvider } from './providers/claude.js';
import type { ProviderOptions, AgentProvider } from './types/agent-provider.js';

// Re-export implementation utilities (used in tests)
export { appendBounded, MAX_STDERR_CHARS } from './providers/claude.js';

// Re-export types with backward-compatible names
export type { ProviderOptions as ClaudeOptions };
export type { AgentProvider as ClaudeWrapper };
export type { PlanResult, StreamEvent, ExecutionCallbacks, ExecutionResult } from './types/agent-provider.js';

// Singleton instance
const provider = new ClaudeProvider();
export const claude: AgentProvider = provider;

// Rate limit state delegates (used by orchestrator.ts and tests)
export function getLastRateLimitResetsAt(): number | null {
  return provider.getRateLimitResetsAt();
}

export function clearRateLimitResetsAt(): void {
  provider.clearRateLimitResetsAt();
}
