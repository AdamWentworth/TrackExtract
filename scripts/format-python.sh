#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${TRACKEXTRACT_TEST_VENV:-"$ROOT_DIR/.venv-python-tests"}"
MODE="${1:-write}"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/python-env.sh"

trackextract_prepare_python_venv "$VENV_DIR" "${PYTHON:-python3}"
"$VENV_PYTHON" -m pip install --quiet --upgrade pip
"$VENV_PYTHON" -m pip install --quiet -e "$ROOT_DIR/engine[dev]"

if [[ "$MODE" == "--check" || "$MODE" == "check" ]]; then
  "$VENV_PYTHON" -m ruff format --check "$ROOT_DIR/engine"
  "$VENV_PYTHON" -m ruff check --select I "$ROOT_DIR/engine"
else
  "$VENV_PYTHON" -m ruff check --select I --fix "$ROOT_DIR/engine"
  "$VENV_PYTHON" -m ruff format "$ROOT_DIR/engine"
fi
