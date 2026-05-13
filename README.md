# TrackExtract

TrackExtract is a local-first desktop prototype for AI stem separation by Phlosion. It is aimed at producers, engineers, DJs, remixers, and creators who need a cleaner workflow than dependency-heavy command-line wrappers: import audio, choose a curated separation task, run an offline job, preview stems, and export DAW-ready files.

This repository currently implements the first Tauri + React + Rust skeleton plus an isolated Demucs worker path for real local stem separation. The shipped model registry now exposes real Demucs presets first; the internal stub backend is kept only for automated tests and development harnesses.

## Current Prototype Scope

- Tauri 2 desktop shell with React and TypeScript.
- Rust-owned app state and UI-independent `trackextract-core` crate.
- Drag/drop and file-picker audio import.
- Project/session folder creation under `TrackExtract Projects`.
- JSON model registry copied into app data on first launch.
- Job queue with queued, preparing, running, complete, failed, and cancelled states.
- Experimental Demucs/PyTorch worker backend for real vocals/instrumental, source-isolation, best-quality four-stem, and six-stem renders.
- Curated model registry entries with source links, license notes, and missing/not-yet-supported ONNX candidates.
- Stem preview and export flows wired to Rust commands.

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
        -> PythonWorkerBackend
        -> OnnxRuntimeBackend       (future)
        -> StubSeparationBackend    (internal tests/dev only)
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

To enable real Demucs separation in development, create the sidecar environment:

```bash
scripts/setup-demucs-worker.sh
```

TrackExtract auto-detects `.venv-demucs/bin/python` when launched from this repo. To force a specific Python environment, set `TRACKEXTRACT_PYTHON`. To force a Demucs device, set `TRACKEXTRACT_DEMUCS_DEVICE` to values such as `cpu` or `cuda`.

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

The bundled registry lives at `resources/models.json`, and the app copies it into local app data on first launch. On later launches, curated bundled entries are synced into the local registry and old prototype stub/placeholder entries are pruned. User-added model ids are left alone.

Installed Demucs worker entries are included for real development renders:

- `demucs_htdemucs_vocals_instrumental` uses Demucs `htdemucs` with `--two-stems=vocals`.
- `demucs_htdemucs_ft_vocals_instrumental` uses fine-tuned `htdemucs_ft` for slower, higher-quality vocal splits.
- `demucs_htdemucs_6s_full_split` uses Demucs `htdemucs_6s` for vocals, drums, bass, guitar, piano, and other.
- `demucs_htdemucs_ft_4stem_best_split` uses fine-tuned `htdemucs_ft` for vocals, drums, bass, and other.
- `demucs_htdemucs_drums_only` and `demucs_htdemucs_bass_only` provide isolated source plus inverse stems.
- `demucs_htdemucs_6s_guitar_only` and `demucs_htdemucs_6s_piano_only` provide experimental isolated source plus inverse stems.

Missing ONNX and RoFormer rows are real catalog candidates, not fake placeholders. They link to model sources such as sherpa-onnx/UVR ONNX releases and Hugging Face RoFormer collections, but they remain unavailable until TrackExtract has a compatible ONNX or RoFormer backend.

Useful public model sources:

- Demucs: https://github.com/facebookresearch/demucs
- UVR ONNX models via sherpa-onnx: https://k2-fsa.github.io/sherpa/onnx/source-separation/models.html
- Hugging Face source-separation models: https://huggingface.co/models?other=source-separation
- RoFormer catalog source: https://huggingface.co/AEmotionStudio/roformer-models

## Roadmap

1. Real ONNX Runtime backend with CPU first.
2. Hardware execution-provider selection for CUDA, DirectML or Windows ML, CoreML, and OpenVINO where practical.
3. Package/manage the Demucs sidecar more cleanly for end users.
4. Curated RoFormer, MDX, and SCNet-compatible model support.
5. Better batch processing, cancellation, and resumable jobs.
6. DAW export templates for Ableton, Logic, Pro Tools, Reaper, and FL Studio.
7. Future VST3/AU bridge plugin that talks to the same offline TrackExtract engine.
