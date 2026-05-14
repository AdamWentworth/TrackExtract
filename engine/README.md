# TrackExtract Engine

This is the Python-first TrackExtract engine. It owns project/session state,
model registry migration, model installs, job lifecycle, catalog sync, and
separation providers. It uses a flat package layout so the repo stays easy to
read while still installing cleanly in editable mode during development.

The Tauri shell calls it through:

```bash
python -m trackextract_engine <command>
```

Layout:

- `trackextract_engine/`: engine package and CLI protocol.
- `trackextract_engine/providers/`: provider dispatch and shared worker runner code.
- `trackextract_engine/workers/`: Python worker scripts for Demucs and audio-separator.
- `tests/`: pytest suite for registry, project, installer, jobs, providers, and JSONL protocol.

Use the repo-level setup script for development:

```bash
scripts/setup-trackextract-engine.sh
```

Run the engine tests from the repository root:

```bash
npm run test:engine
```
