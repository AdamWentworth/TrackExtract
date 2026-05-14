# Track Extract

Track Extract is a local-first desktop prototype for AI stem separation. It is aimed at producers, engineers, DJs, remixers, and creators who need a cleaner workflow than dependency-heavy command-line wrappers: import audio, choose a curated separation task, run an offline job, preview stems, and export DAW-ready files.

This repository currently implements a Tauri + React desktop shell backed by a Python-first Track Extract engine. Rust is now a thin Tauri bridge for app paths, process spawning, cancellation, local media preview, and event forwarding. Python owns projects, sessions, jobs, model registry state, model installs, catalog sync, and separation providers.

## Current Prototype Scope

- Tauri 2 desktop shell with React and TypeScript.
- Thin Rust/Tauri bridge with Python-owned app state.
- Drag/drop and file-picker audio import.
- Project/session folder creation under `TrackExtract Projects`.
- JSON model registry copied into app data on first launch.
- Job queue with queued, preparing, running, complete, failed, and cancelled states.
- Python engine providers for Demucs, audio-separator, and stub/test renders.
- audio-separator catalog sync for discovering supported local model filenames.
- Expanded model registry with Demucs runtime presets, downloadable public UVR model files, MVSEP catalog references, source links, license notes, and not-yet-supported backend candidates.
- Managed model installer for downloadable catalog entries, with app-data storage and progress events.
- Stem preview and export flows wired through stable Tauri commands.

The MVP does not include real-time separation, a DAW plugin, cloud processing, account logic, payments, or a production model downloader.

## Architecture

The canonical engine source lives in `engine/src`, packaged as `trackextract_engine`. It exposes `python -m trackextract_engine` for the Rust bridge and future CLI/service work. Rust is limited to the Tauri shell and local desktop plumbing.

See [docs/architecture.md](docs/architecture.md) for the command/event flow and backend boundaries.

## Repository Layout

- `src/`: React/TypeScript frontend.
- `src-tauri/`: Tauri 2 shell, command bridge, event forwarding, cancellation, and local media server.
- `engine/`: Python engine source, tests, and package metadata. This is the product engine.
- `resources/`: Bundled model and workflow registries copied into app data.
- `schemas/`: JSON schemas for documented registry/session formats.
- `scripts/`: Setup, validation, and test entrypoints.
- `docs/`: Architecture, development, model-registry, and packaging notes.

## Build

Install Rust stable and the Tauri prerequisites for your OS. On Ubuntu-like Linux systems, Tauri also needs WebKit/RSVG/AppIndicator development packages:

```bash
sudo apt update
sudo apt install pkg-config libdbus-1-dev libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Then install JavaScript dependencies and run the app:

```bash
npm install
npm run tauri dev
```

To enable the Python engine in development, create the managed environment:

```bash
scripts/setup-trackextract-engine.sh
```

Track Extract auto-detects `.venv-trackextract-engine/bin/python` when launched from this repo. To force a specific Python environment, set `TRACKEXTRACT_ENGINE_PYTHON`. For NVIDIA CUDA support in audio-separator, install/update the environment with `TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu`; for Windows DirectML, use `TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=dml`.

See [docs/development.md](docs/development.md) for toolchain pins, environment overrides, and local check commands.

For browser-only UI iteration with mock project/job data:

```bash
npm run dev:browser
```

When the dev server is running on `http://localhost:1420`, both the Tauri desktop window and a normal browser tab use the same local Python engine bridge. Imports, current project/session state, jobs, generated stems, and model/workflow registry changes are shared between both views during development.

If you launch the dev terminal from the Snap build of VS Code and see a `libpthread`
symbol lookup error when Tauri starts, run the clean environment helper instead:

```bash
npm run tauri:dev:clean
```

For the full local suite, use:

```bash
npm run check
```

Network checks for model download URLs are kept opt-in so local tests are not flaky:

```bash
TRACKEXTRACT_TEST_NETWORK=1 npm run test:all
```

## Model Registry

The generated bundled registry lives at `resources/models.json`, and source fragments live under `resources/models/`.

```bash
npm run models:build
npm run test:models
```

See [docs/model-registry.md](docs/model-registry.md) for registry structure, model sources, and install-state semantics.

## Roadmap

1. Bundle/package the Python engine cleanly for end users.
2. Expand audio-separator catalog sync into curated installable workflows.
3. Improve multi-step vocal cleanup execution.
4. Add native ONNX Runtime only for models where it clearly improves packaging or acceleration.
5. Better batch processing, cancellation, and resumable jobs.
6. DAW export templates for Ableton, Logic, Pro Tools, Reaper, and FL Studio.
7. Future VST3/AU bridge plugin that talks to the same offline Track Extract engine.
