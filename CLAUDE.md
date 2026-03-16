# planbot CLAUDE.md

AI-agent context for the planbot codebase.

## Project Overview

planbot is a CLI tool that orchestrates AI coding agents (currently Claude Code CLI) against a queue of tickets defined in `tickets.yaml`. It handles planning, execution, rate limiting, approval flows, and hook lifecycle.

## Key Directories

```
src/
├── cli/              # Entry points and CLI command handlers
├── core/
│   ├── types/        # Shared TypeScript interfaces (AgentProvider, etc.)
│   ├── providers/    # Agent provider implementations
│   │   ├── index.ts  # Provider registry and createProvider() factory
│   │   └── claude.ts # ClaudeProvider — Claude Code CLI wrapper
│   ├── orchestrator.ts  # Main ticket execution loop
│   ├── schemas.ts       # Zod schemas for config (tickets.yaml)
│   ├── state.ts         # Persistent run state
│   ├── hooks.ts         # Hook lifecycle (before/after ticket, etc.)
│   └── claude.ts        # Backward-compat shim re-exporting ClaudeProvider
└── utils/            # Duration parsing, interruptible delays, etc.
```

## Multi-Provider Architecture

planbot uses a provider abstraction so alternative AI coding agent backends can be added without changing the orchestrator.

### File Structure

```
src/core/types/agent-provider.ts   # AgentProvider interface + supporting types
src/core/providers/index.ts        # createProvider() factory + registry
src/core/providers/claude.ts       # ClaudeProvider (Claude Code CLI)
src/core/claude.ts                 # Backward-compat shim (re-exports only)
```

### Key Types

All defined in `src/core/types/agent-provider.ts`:

- `AgentProvider` — interface every provider must implement
- `AgentProviderMetadata` — `{ name: string; supportedModels: readonly string[] }`
- `ProviderOptions` — per-call options (`model`, `sessionId`, `cwd`, `timeout`, etc.)
- `ExecutionCallbacks` — streaming callbacks (`onEvent`, `onQuestion`, `onOutput`)
- `StreamEvent` — typed union of events emitted during execution
- `ExecutionResult`, `PlanResult`, `PromptResult` — return types for provider methods

### AgentProvider Interface

Required methods:

```typescript
generatePlan(prompt, options?, onOutput?): Promise<PlanResult>
execute(prompt, options, callbacks): Promise<ExecutionResult>
resume(sessionId, input, options, callbacks): Promise<ExecutionResult>
answerQuestion(answer): void
abort(): void
runPrompt(prompt, options?): Promise<PromptResult>
getRateLimitResetsAt(): number | null
clearRateLimitResetsAt(): void
```

Required property: `readonly metadata: AgentProviderMetadata`

### Adding a New Provider

1. Create `src/core/providers/<name>.ts` implementing `AgentProvider`
2. Export the class and ensure `metadata.name` matches the registry key
3. Register it in `src/core/providers/index.ts`:
   ```typescript
   import { MyProvider } from './my-provider.js';
   const providers: Record<string, () => AgentProvider> = {
     claude: () => new ClaudeProvider(),
     my-provider: () => new MyProvider(),   // add here
   };
   ```
4. Add the new value to `ProviderSchema` in `src/core/schemas.ts`:
   ```typescript
   export const ProviderSchema = z.enum(["claude", "my-provider"]);
   ```
5. Add contract tests in `src/core/__tests__/agent-provider-contract.test.ts` covering the new provider

### Backward Compatibility

`src/core/claude.ts` re-exports all original symbols from `ClaudeProvider` so existing imports and test mocks continue to work unchanged. Do not add logic to this shim — it exists solely for import compatibility.

### Rate Limit State

Rate limit reset timestamps (`resetsAt`) are stored per-provider instance, not module-level. If the orchestrator creates a new provider instance mid-run, rate limit state does not carry over. The orchestrator uses a singleton provider instance for the lifetime of a run.

## Config Schema

`src/core/schemas.ts` defines all Zod schemas for `tickets.yaml`. Key fields:

- `provider` — `z.enum(["claude"])`, defaults to `"claude"`
- `rateLimitRetry` — wait-and-retry config for rate limit events
- `pacing` — delay controls between tickets/iterations/retries
- `maxPlanRevisions` — how many times a plan can be revised after rejection (default: 3)

## Testing Conventions

- Tests live in `src/core/__tests__/` alongside source files
- Provider contract tests: `agent-provider-contract.test.ts` — run against any `AgentProvider` instance
- Orchestrator tests mock the provider via `OrchestratorOptions.provider`
- Security tests are in dedicated `*.security.test.ts` files
