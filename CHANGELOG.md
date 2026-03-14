# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
