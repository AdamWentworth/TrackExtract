# TrackExtract

TrackExtract is a local-first desktop prototype for AI stem separation by Phlosion. It is aimed at producers, engineers, DJs, remixers, and creators who need a cleaner workflow than dependency-heavy command-line wrappers: import audio, choose a curated separation task, run an offline job, preview stems, and export DAW-ready files.

This repository currently implements a Tauri + React desktop shell backed by a Python-first TrackExtract engine. Rust is now a thin Tauri bridge for app paths, process spawning, cancellation, local media preview, and event forwarding. Python owns projects, sessions, jobs, model registry state, model installs, catalog sync, and separation providers.

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

```text
React/Tauri UI
  -> Tauri commands/events
  -> thin Rust bridge
  -> Python TrackExtract engine
     -> project/session manager
     -> model registry
     -> job queue
     -> audio file handling
     -> output folder management
     -> logging/progress events
     -> backend selection
        -> Demucs provider
        -> audio-separator provider
        -> Stub provider
```

The canonical engine package lives in `engine/trackextract_engine`. It exposes `python -m trackextract_engine` for the Rust bridge and future CLI/service work. Rust is limited to the Tauri shell and local desktop plumbing.

## Repository Layout

- `src/`: React/TypeScript frontend.
- `src-tauri/`: Tauri 2 shell, command bridge, event forwarding, cancellation, and local media server.
- `engine/`: Python package, engine tests, and package metadata. This is the product engine.
- `resources/`: Bundled model and workflow registries copied into app data.
- `schemas/`: JSON schemas for documented registry/session formats.
- `scripts/`: Setup, validation, and test entrypoints.

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

TrackExtract auto-detects `.venv-trackextract-engine/bin/python` when launched from this repo. To force a specific Python environment, set `TRACKEXTRACT_ENGINE_PYTHON`. For NVIDIA CUDA support in audio-separator, recreate the environment with `TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu`; for Windows DirectML, use `TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=dml`.

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
npm run test:engine
npm run test:rust
```

For the broader local suite, use:

```bash
npm run test:all
```

That runs model-registry validation, Python engine tests, frontend tests, the production frontend build, Rust formatting checks, and Rust tests. Network checks for model download URLs are kept opt-in so local tests are not flaky:

```bash
TRACKEXTRACT_TEST_NETWORK=1 npm run test:all
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

The bundled registry lives at `resources/models.json`, and the Python engine copies it into local app data on first launch. On later launches, curated bundled entries are synced into the local registry and old prototype stub/placeholder entries are pruned. User-added model ids are left alone.

Installed Demucs provider entries are included for real development renders:

- `demucs_htdemucs_vocals_instrumental` uses Demucs `htdemucs` with `--two-stems=vocals`.
- `demucs_htdemucs_ft_vocals_instrumental` uses fine-tuned `htdemucs_ft` for slower, higher-quality vocal splits.
- `demucs_htdemucs_6s_full_split` uses Demucs `htdemucs_6s` for vocals, drums, bass, guitar, piano, and other.
- `demucs_htdemucs_ft_4stem_best_split` uses fine-tuned `htdemucs_ft` for vocals, drums, bass, and other.
- `demucs_htdemucs_drums_only` and `demucs_htdemucs_bass_only` provide isolated source plus inverse stems.
- `demucs_htdemucs_6s_guitar_only` and `demucs_htdemucs_6s_piano_only` provide experimental isolated source plus inverse stems.
- `uvr_mdx23c_instvoc_hq` catalogs MDX23C InstVoc HQ for high-quality vocal/instrumental extraction.
- `onnx_uvr_mdxnet_karaoke_2` catalogs UVR MDX-NET Karaoke 2 for layered/backing vocal cleanup.
- `onnx_uvr_mdxnet_voc_ft` catalogs UVR MDX-NET Voc FT for vocal-focused refinement.
- `onnx_reverb_hq_by_foxjoy` catalogs Reverb HQ By FoxJoy for vocal dereverb.
- `uvr_denoise` catalogs UVR DeNoise for final vocal cleanup.

The bundled catalog now includes the public UVR single-model release model files as managed downloads, excluding YAML/config sidecars that are not useful as standalone choices in the UI. It also includes MVSEP separation and restoration algorithms as source references so producers can discover RoFormer, SCNet, MDX, drum, guitar, piano, wind, string, percussion, dereverb, denoise, and restoration options without leaving the model manager. ASR, TTS, MIDI extraction, mastering, and music-generation entries from MVSEP are intentionally not modeled as runnable TrackExtract separation tasks yet.

Missing ONNX, RoFormer, MDX23C, and VR rows are real catalog candidates, not fake placeholders. Downloadable `.onnx`, `.pth`, and `.ckpt` entries run through the Python audio-separator provider after setup. Raw `.th` Demucs weights are still cataloged, but they need matching YAML model definitions before TrackExtract can run them. MVSEP rows without direct model files remain source references until a local compatible model or service adapter exists.

Downloadable entries with paths under `models/` can be installed from the UI. audio-separator entries discovered from the Model Library sync can be prefetched through audio-separator itself. TrackExtract stores local files in app data, updates the editable local registry, and emits progress through `model_download_progress`.

Useful public model sources:

- Demucs: https://github.com/facebookresearch/demucs
- Public UVR single-model release: https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models
- MVSEP algorithm catalog: https://mvsep.com/en
- UVR ONNX models via sherpa-onnx: https://k2-fsa.github.io/sherpa/onnx/source-separation/models.html
- Hugging Face source-separation models: https://huggingface.co/models?other=source-separation
- RoFormer catalog source: https://huggingface.co/AEmotionStudio/roformer-models

## Roadmap

1. Bundle/package the Python engine cleanly for end users.
2. Expand audio-separator catalog sync into curated installable workflows.
3. Improve multi-step vocal cleanup execution.
4. Add native ONNX Runtime only for models where it clearly improves packaging or acceleration.
5. Better batch processing, cancellation, and resumable jobs.
6. DAW export templates for Ableton, Logic, Pro Tools, Reaper, and FL Studio.
7. Future VST3/AU bridge plugin that talks to the same offline TrackExtract engine.
