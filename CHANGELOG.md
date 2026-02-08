# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `maxPlanRevisions` config option (default: 3) — controls how many times a plan can be revised after rejection with feedback
- `approved` and `rejectionReason` fields on `HookContext` interface, exposed as `PLANBOT_APPROVED` and `PLANBOT_REJECTION_REASON` environment variables in shell hooks

### Fixed

- Plan rejection with feedback now triggers re-planning instead of immediately skipping the ticket
- Dead code bug in `waitForApproval()` where `pendingApprovals.delete(planId)` was immediately followed by `pendingApprovals.get(planId)` (always `undefined`)
