#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${TRACKEXTRACT_TEST_VENV:-"$ROOT_DIR/.venv-python-tests"}"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/python-env.sh"

trackextract_prepare_python_venv "$VENV_DIR" "${PYTHON:-python3}"
"$VENV_PYTHON" -m pip install --quiet --upgrade pip
"$VENV_PYTHON" -m pip install --quiet -e "$ROOT_DIR/engine[dev]"
"$VENV_PYTHON" -m ruff check "$ROOT_DIR/engine"
