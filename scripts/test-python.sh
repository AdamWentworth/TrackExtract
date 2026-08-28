#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${TRACKEXTRACT_TEST_VENV:-"$ROOT_DIR/.venv-python-tests"}"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/python-env.sh"

trackextract_prepare_python_venv "$VENV_DIR" "${PYTHON:-python3}"
"$VENV_PYTHON" -m pip install --quiet --upgrade pip
"$VENV_PYTHON" -m pip install --quiet -e "$ROOT_DIR/engine[dev]"
mkdir -p "$ROOT_DIR/.artifacts/coverage/python"
"$VENV_PYTHON" -m pytest \
  --cov="$ROOT_DIR/engine/src" \
  --cov-branch \
  --cov-report=term-missing:skip-covered \
  --cov-report="json:$ROOT_DIR/.artifacts/coverage/python/coverage.json" \
  --cov-fail-under=50 \
  "$ROOT_DIR/engine/tests"
