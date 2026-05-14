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

Copy `.env.example` if you need local overrides:

```bash
cp .env.example .env
```

## Running

Browser-only UI iteration:

```bash
npm run dev:browser
```

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
