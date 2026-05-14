#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "TrackExtract now uses scripts/setup-trackextract-engine.sh for the primary Python runtime."
echo "Continuing with the legacy Demucs-only environment setup."

VENV_DIR="${TRACKEXTRACT_DEMUCS_VENV:-"$ROOT_DIR/.venv-demucs"}"
PYTHON_BIN="${PYTHON:-python3}"

echo "Creating Demucs worker environment at $VENV_DIR"
"$PYTHON_BIN" -m venv "$VENV_DIR"

if [[ -x "$VENV_DIR/bin/python" ]]; then
  VENV_PYTHON="$VENV_DIR/bin/python"
else
  VENV_PYTHON="$VENV_DIR/Scripts/python.exe"
fi

"$VENV_PYTHON" -m pip install --upgrade pip wheel
"$VENV_PYTHON" -m pip install "demucs==4.0.1" torchcodec static-ffmpeg

"$VENV_PYTHON" - <<'PY'
import importlib.util

torch_spec = importlib.util.find_spec("torch")
demucs_spec = importlib.util.find_spec("demucs")
print(f"demucs installed: {demucs_spec is not None}")
print(f"torch installed: {torch_spec is not None}")
if torch_spec is not None:
    import torch
    print(f"torch version: {torch.__version__}")
    print(f"cuda available: {torch.cuda.is_available()}")
PY

echo
echo "Done. TrackExtract will auto-detect $VENV_PYTHON when launched from this repo."
echo "To force this Python from another launch context, set:"
echo "  export TRACKEXTRACT_PYTHON=\"$VENV_PYTHON\""
