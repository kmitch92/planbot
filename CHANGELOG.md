# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Rate Limit Wait-and-Retry**: Opt-in feature (`config.rateLimitRetry.enabled: true`) that waits for Claude session/usage limits to reset instead of failing. When both primary and fallback models are rate-limited, planbot captures the `resetsAt` timestamp from Claude CLI's `rate_limit_event` and waits before retrying.
  - `maxWaitTime`: Maximum wait duration per reset cycle (default: `6h`)
  - `retryBuffer`: Buffer added after reset time before retry (default: `30s`)
  - `fallbackDelay`: Delay used when reset timestamp is unavailable (default: `5m`)
  - `notifyOnWait`: Send messaging notification when entering a wait (default: `true`)
  - Interruptible: pause/stop commands abort the wait cleanly
- Parse `rate_limit_event` from Claude CLI stream-json output, storing `resetsAt` for retry timing
- `calculateRateLimitWait()` pure function for wait duration computation
- `RateLimitRetrySchema` with duration fields for YAML configuration
- Rate limit retry template block in `planbot init` advanced template
- **Time-based pacing controls**: Configurable delays between Claude executions to spread token usage across time windows
  - `config.pacing.delayBetweenTickets`: Delay after a ticket completes before the next starts (e.g., `"5m"`)
  - `config.pacing.delayBetweenIterations`: Delay between loop iterations (e.g., `"2m"`)
  - `config.pacing.delayBetweenRetries`: Delay between retry attempts (e.g., `"30s"`)
  - `config.pacing.startAfter`: ISO datetime to defer queue processing (e.g., `"2026-03-15T06:00:00Z"`)
  - Per-ticket `pacing` overrides for fine-grained control
  - All delays are interruptible by pause/stop commands
- Duration utility (`src/utils/duration.ts`): Human-readable duration parsing (`"1h30m"`, `"5m"`, `"30s"`) with Zod schema
- Interruptible delay utility (`src/utils/interruptible-delay.ts`): Cancellable sleep with polling and interrupt support
- `maxPlanRevisions` config option (default: 3) — controls how many times a plan can be revised after rejection with feedback
- `approved` and `rejectionReason` fields on `HookContext` interface, exposed as `PLANBOT_APPROVED` and `PLANBOT_REJECTION_REASON` environment variables in shell hooks

### Fixed

- Plan rejection with feedback now triggers re-planning instead of immediately skipping the ticket
- Dead code bug in `waitForApproval()` where `pendingApprovals.delete(planId)` was immediately followed by `pendingApprovals.get(planId)` (always `undefined`)
