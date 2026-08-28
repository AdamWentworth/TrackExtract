# Contributing

Track Extract is an early-stage local desktop application. Keep changes focused, preserve local-first behavior, and
avoid adding network services or telemetry without an explicit design discussion.

## Before opening a pull request

1. Install Node, Python, Rust, and the platform-specific Tauri prerequisites from `README.md`.
2. Run `npm ci` and `scripts/setup-trackextract-engine.sh`. On Windows, use
   `scripts/setup-trackextract-engine.ps1` instead.
3. Run `npm run check`.
4. For model registry changes, also run `TRACKEXTRACT_TEST_NETWORK=1 npm run test:models:network` when network access is
   available.

Tests should cover observable behavior and failure paths. Security boundaries, job-state transitions, filesystem
containment, cancellation, and performance budgets should not be weakened without a documented reason.
