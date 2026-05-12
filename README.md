# TrackExtract

TrackExtract is a local-first desktop prototype for AI stem separation by Phlosion. It is aimed at producers, engineers, DJs, remixers, and creators who need a cleaner workflow than dependency-heavy command-line wrappers: import audio, choose a curated separation task, run an offline job, preview stems, and export DAW-ready files.

This repository currently implements the first Tauri + React + Rust skeleton. The separation backend is intentionally a stub that writes valid placeholder WAV stems, which lets the product workflow, project/session format, queue states, model registry, and export path settle before real inference is added.

## Current Prototype Scope

- Tauri 2 desktop shell with React and TypeScript.
- Rust-owned app state and UI-independent `trackextract-core` crate.
- Drag/drop and file-picker audio import.
- Project/session folder creation under `TrackExtract Projects`.
- JSON model registry copied into app data on first launch.
- Job queue with queued, preparing, running, complete, failed, and cancelled states.
- Stub separation backend using `symphonia` for decoding and `hound` for WAV output.
- Stem preview and export UI placeholders wired to Rust commands.

The MVP does not include real-time separation, a DAW plugin, cloud processing, account logic, payments, or a production model downloader.

## Architecture

```text
React/Tauri UI
  -> Tauri commands/events
  -> Rust core engine
     -> project/session manager
     -> model registry
     -> job queue
     -> audio file handling
     -> output folder management
     -> logging/progress events
     -> backend selection
        -> StubSeparationBackend
        -> OnnxRuntimeBackend       (future)
        -> PythonWorkerBackend      (future)
```

The `crates/trackextract-core` crate has no Tauri dependency. That boundary is deliberate so the same engine can later power a CLI, local background service, or JUCE VST3/AU bridge without making the desktop UI the center of the system.

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

For browser-only UI iteration with mock project/job data:

```bash
npm run dev:browser
```

If you launch the dev terminal from the Snap build of VS Code and see a `libpthread`
symbol lookup error when Tauri starts, run the clean environment helper instead:

```bash
npm run tauri:dev:clean
```

Useful checks:

```bash
npm run build
npm test
cargo test
```

## Project Output

A project uses predictable DAW-friendly folders:

```text
TrackExtract Projects/
  Artist - Song/
    original/
    stems/
      Artist - Song - Vocals.wav
      Artist - Song - Drums.wav
      Artist - Song - Bass.wav
      Artist - Song - Guitar.wav
      Artist - Song - Piano.wav
      Artist - Song - Other.wav
    renders/
    logs/
    session.json
```

## Model Registry

The bundled registry lives at `resources/models.json`, and the app copies it into local app data on first launch. Each entry records model id, display name, supported tasks, expected stems, sample rate, backend kind, local path, placeholder download URL, version, quality label, and installed/missing status.

Stub models are installed for app development. ONNX and PyTorch worker entries are intentionally present as missing placeholders so the UI can show the future model management shape without pretending real downloads are implemented.

## Roadmap

1. Real ONNX Runtime backend with CPU first.
2. Hardware execution-provider selection for CUDA, DirectML or Windows ML, CoreML, and OpenVINO where practical.
3. Isolated Python/PyTorch worker backend for experimental models that are not portable to ONNX yet.
4. Curated RoFormer, Demucs, MDX, and SCNet-compatible model support.
5. Better batch processing, cancellation, and resumable jobs.
6. DAW export templates for Ableton, Logic, Pro Tools, Reaper, and FL Studio.
7. Future VST3/AU bridge plugin that talks to the same offline TrackExtract engine.
