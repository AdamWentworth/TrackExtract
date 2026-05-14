#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${TRACKEXTRACT_TEST_VENV:-"$ROOT_DIR/.venv-python-tests"}"
PYTHON_BIN="${PYTHON:-python3}"

if [[ ! -x "$VENV_DIR/bin/python" && ! -x "$VENV_DIR/Scripts/python.exe" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if [[ -x "$VENV_DIR/bin/python" ]]; then
  VENV_PYTHON="$VENV_DIR/bin/python"
else
  VENV_PYTHON="$VENV_DIR/Scripts/python.exe"
fi

"$VENV_PYTHON" -m pip install --quiet --upgrade pip pytest
PYTHONPATH="$ROOT_DIR/python" "$VENV_PYTHON" -m pytest "$ROOT_DIR/python/tests"
