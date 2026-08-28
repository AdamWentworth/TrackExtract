# Development

## Toolchains

This repo pins local toolchain intent with:

- `.nvmrc`: Node 24
- `.python-version`: Python 3.12
- `rust-toolchain.toml`: stable Rust with `rustfmt` and `clippy`

## Setup

Install JavaScript dependencies:

```bash
npm install
```

Create the managed Python engine environment:

```bash
scripts/setup-trackextract-engine.sh
```

Windows PowerShell uses the native setup entrypoint:

```powershell
scripts/setup-trackextract-engine.ps1
```

Local overrides are supplied as shell environment variables. The project does
not load a committed `.env.example`; keeping those values explicit avoids
confusion between Vite, npm scripts, Rust, and Python subprocesses.

## Python Dependencies

Python package metadata lives in `engine/pyproject.toml`. Track Extract does not
keep a separate `requirements.txt` because that would duplicate dependency
state and drift from the installable package metadata.

The managed local virtual environments are generated folders:

- `.venv-trackextract-engine`: development runtime used by the Tauri bridge.
- `.venv-python-tests`: test/lint/format environment used by scripts.

Both are ignored by git. Recreate them with the setup or test scripts instead
of committing them.

Runtime provider dependencies are optional package extras:

```bash
python -m pip install -e "engine[runtime-cpu]"
python -m pip install -e "engine[runtime-gpu]"
python -m pip install -e "engine[runtime-dml]"
```

Use the setup scripts for GPU environments. PyPI's default Windows PyTorch
package is CPU-only, so the scripts install the aligned CUDA 11.8 wheels and
validate a real CUDA tensor operation. Directly installing `runtime-gpu` does
not select PyTorch's separate CUDA package index.

The setup script chooses the matching extra from
`TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA`.

Examples:

```bash
TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu scripts/setup-trackextract-engine.sh
TRACKEXTRACT_ENGINE_PYTHON=/absolute/path/to/python npm run tauri:dev
TRACKEXTRACT_TEST_NETWORK=1 npm run test:all
```

```powershell
scripts/setup-trackextract-engine.ps1 -Runtime gpu
$env:TRACKEXTRACT_ENGINE_PYTHON = "$PWD\.venv-trackextract-engine\Scripts\python.exe"
npm run tauri:dev
```

## Packaging Status

Track Extract currently uses the managed development Python environment rather
than bundling Python and provider dependencies into the desktop installers.
Tauri can produce Windows MSI and NSIS packages, but those packages are not yet
self-contained end-user releases. Production packaging still needs an explicit
strategy for the Python runtime, provider dependencies, model caches, and
hardware-specific acceleration packages on each platform.

## Project Output

Projects use predictable DAW-friendly folders:

```text
Track Extract Projects/
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

## Automation Scripts

The `scripts/` directory is intentional. This repo spans npm, Tauri/Rust,
Python packaging, and generated model metadata, so package scripts delegate to
small shell or Node helpers when the command would be brittle or unreadable
inline.

Most day-to-day entrypoints still go through `package.json`:

```bash
npm run check
npm run test:engine
npm run test:rust
npm run test:performance
npm run models:build
```

## Running

Browser-only UI iteration:

```bash
npm run dev:browser
```

The browser tab is not a separate mock app when it runs on port `1420`. Vite exposes a development-only Track Extract bridge at `/__trackextract_dev/*`, so browser commands use the real Python engine. The Tauri window uses its native command bridge, while both surfaces share persisted project/session state. Browser file imports are uploaded to the local dev bridge first; desktop-selected files use their native paths directly.

Tauri desktop development:

```bash
npm run tauri:dev
```

The repo's npm Tauri scripts run through `scripts/tauri-env.sh`, which strips Snap VS Code's GTK/GIO environment before
launching Tauri. Raw `tauri dev` commands from Snap VS Code terminals may still hit a `libpthread` symbol lookup error.

## Checks

Common commands:

```bash
npm run format
npm run format:check
npm run lint
npm run test:all
npm run test:performance
npm run check
```

`npm run check` runs formatting checks, linters, registry validation, Python engine tests, frontend tests, the production frontend build, Rust clippy, and Rust tests.

`npm run test:performance` runs a real 8 MiB browser drag-and-drop import through the development bridge and enforces explicit budgets for visible feedback, project readiness, source buffering, waveform decoding, and playback start. CI runs it separately after installing Chromium.

Network model URL checks are opt-in:

```bash
TRACKEXTRACT_TEST_NETWORK=1 npm run test:all
```
