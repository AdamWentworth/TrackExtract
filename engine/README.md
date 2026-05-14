# Track Extract Engine

<p align="center">
  <img src="../docs/assets/brand/trackextract-logo-row.png" width="420" alt="TrackExtract" />
</p>

This is the Python-first Track Extract engine. It owns project/session state,
model registry migration, model installs, job lifecycle, catalog sync, and
separation providers. The source code lives directly in `src/` and is packaged
as the Python module `trackextract_engine`.

The Tauri shell calls it through:

```bash
python -m trackextract_engine <command>
```

Layout:

- `src/`: engine package and CLI protocol.
- `src/providers/`: provider dispatch and shared worker runner code.
- `src/workers/`: Python worker scripts for Demucs and audio-separator.
- `tests/`: pytest suite for registry, project, installer, jobs, providers, and JSONL protocol.

Use the repo-level setup script for development:

```bash
scripts/setup-trackextract-engine.sh
```

Run the engine tests from the repository root:

```bash
npm run test:engine
```
