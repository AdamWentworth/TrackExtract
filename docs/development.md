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

The setup script chooses the matching extra from
`TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA`.

Examples:

```bash
TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu scripts/setup-trackextract-engine.sh
TRACKEXTRACT_ENGINE_PYTHON=/absolute/path/to/python npm run tauri dev
TRACKEXTRACT_TEST_NETWORK=1 npm run test:all
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
npm run models:build
```

## Running

Browser-only UI iteration:

```bash
npm run dev:browser
```

The browser tab is not a separate mock app when it runs on port `1420`. Vite exposes a development-only Track Extract bridge at `/__trackextract_dev/*`, and both the browser tab and Tauri desktop window use that bridge for Python-engine commands. That means project/session state, imports, jobs, generated stems, model installs, and workflow changes are shared while developing. Browser file imports are uploaded to the local dev bridge first, then imported through the same engine path as desktop-selected files.

Tauri desktop development:

```bash
npm run tauri dev
```

If the terminal is launched from the Snap build of VS Code and Tauri hits a `libpthread` symbol lookup error, use:

```bash
npm run tauri:dev:clean
```

## Checks

Common commands:

```bash
npm run format
npm run format:check
npm run lint
npm run test:all
npm run check
```

`npm run check` runs formatting checks, linters, registry validation, Python engine tests, frontend tests, the production frontend build, Rust clippy, and Rust tests.

Network model URL checks are opt-in:

```bash
TRACKEXTRACT_TEST_NETWORK=1 npm run test:all
```
