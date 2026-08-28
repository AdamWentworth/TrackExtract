# Quality baseline

This document records the engineering baseline for the pre-release project. Scores are directional rather than a
substitute for release criteria.

| Area                   | Rating | Current guardrail                                                                                   |
| ---------------------- | -----: | --------------------------------------------------------------------------------------------------- |
| Dependency security    |   8/10 | npm audit, RustSec audit, GitHub vulnerability alerts, maintainer-controlled updates                |
| Functional correctness |   7/10 | React behavior tests, Python engine tests, Rust unit tests, production browser smoke test           |
| Reliability            |   7/10 | Atomic JSON replacement, cross-process state lock, guarded job transitions, project-bound jobs      |
| Security boundaries    |   7/10 | Same-origin dev bridge, streamed bounded uploads, capability-token media server, contained paths    |
| Performance            |   7/10 | Bundle budgets, bounded waveform memory/cache, two-at-a-time waveform decoding, single-call polling |
| Maintainability        |   6/10 | Typed UI and split waveform/security modules; `App.tsx` remains too large                           |
| Release readiness      |   5/10 | Cross-platform CI exists, but the Python runtime is not yet bundled for end users                   |

## Enforced baselines

- Frontend coverage must remain at or above 65% statements/lines, 60% functions, and 60% branches.
- Python combined line/branch coverage must remain at or above 50%.
- Production JavaScript must remain at or below 110 KiB gzip and CSS at or below 10 KiB gzip.
- High-severity npm audit findings fail CI.
- Model and workflow registries must remain reproducible and schema-valid.

## Known residual risks

1. Production installers do not yet bundle a Python interpreter and provider runtime. A packaged build still depends on
   a developer-managed engine environment.
2. The main React module remains large. Continue extracting command adapters and model/workflow panels behind tests.
3. Real Demucs and audio-separator inference is covered at command-construction boundaries, but full model execution is
   too large and hardware-dependent for the standard CI suite. Add a scheduled fixture-based runtime lane.
4. Most upstream public model assets do not publish checksums. SHA-256 is enforced when a registry entry provides one;
   size, host, redirect, and timeout limits protect entries without a publisher digest.
5. `RUSTSEC-2024-0429` remains in Tauri's Linux GTK dependency chain. Track Extract does not use the affected
   `glib::VariantStrIter` API; the exception is documented in `SECURITY.md` and must be removed with the upstream
   dependency migration.
6. Protect `main` after this hardening change lands, requiring the CI workflow before merge. Enabling it before the
   first protected commit would prevent these local changes from landing directly.
