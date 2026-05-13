#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${TRACKEXTRACT_AUDIO_SEPARATOR_VENV:-"$ROOT_DIR/.venv-audio-separator"}"
PYTHON_BIN="${PYTHON:-python3}"
AUDIO_SEPARATOR_VERSION="${TRACKEXTRACT_AUDIO_SEPARATOR_VERSION:-0.44.1}"
AUDIO_SEPARATOR_EXTRA="${TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA:-cpu}"

echo "Creating audio-separator worker environment at $VENV_DIR"
"$PYTHON_BIN" -m venv "$VENV_DIR"

if [[ -x "$VENV_DIR/bin/python" ]]; then
  VENV_PYTHON="$VENV_DIR/bin/python"
else
  VENV_PYTHON="$VENV_DIR/Scripts/python.exe"
fi

"$VENV_PYTHON" -m pip install --upgrade pip wheel
"$VENV_PYTHON" -m pip install "audio-separator[$AUDIO_SEPARATOR_EXTRA]==$AUDIO_SEPARATOR_VERSION"

"$VENV_PYTHON" - <<'PY'
from importlib import metadata
import importlib.util

print(f"audio-separator version: {metadata.version('audio-separator')}")
print(f"torch installed: {importlib.util.find_spec('torch') is not None}")
print(f"onnxruntime installed: {importlib.util.find_spec('onnxruntime') is not None}")

try:
    import torch
    print(f"torch version: {torch.__version__}")
    print(f"cuda available: {torch.cuda.is_available()}")
except Exception as error:
    print(f"torch probe failed: {error}")
PY

echo
echo "Done. TrackExtract will auto-detect $VENV_PYTHON when launched from this repo."
echo "To force this Python from another launch context, set:"
echo "  export TRACKEXTRACT_AUDIO_SEPARATOR_PYTHON=\"$VENV_PYTHON\""
echo
echo "For NVIDIA CUDA, recreate with:"
echo "  TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu scripts/setup-audio-separator-worker.sh"
echo "For Windows DirectML, use:"
echo "  TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=dml scripts/setup-audio-separator-worker.sh"
