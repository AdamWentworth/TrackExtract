#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${TRACKEXTRACT_ENGINE_VENV:-"$ROOT_DIR/.venv-trackextract-engine"}"
PYTHON_BIN="${PYTHON:-python3}"
AUDIO_SEPARATOR_VERSION="${TRACKEXTRACT_AUDIO_SEPARATOR_VERSION:-0.44.1}"
AUDIO_SEPARATOR_EXTRA="${TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA:-cpu}"

echo "Creating TrackExtract Python engine environment at $VENV_DIR"
"$PYTHON_BIN" -m venv "$VENV_DIR"

if [[ -x "$VENV_DIR/bin/python" ]]; then
  VENV_PYTHON="$VENV_DIR/bin/python"
else
  VENV_PYTHON="$VENV_DIR/Scripts/python.exe"
fi

"$VENV_PYTHON" -m pip install --upgrade pip wheel
"$VENV_PYTHON" -m pip install -e "$ROOT_DIR/engine"
"$VENV_PYTHON" -m pip install static-ffmpeg "demucs==4.0.1" "audio-separator[$AUDIO_SEPARATOR_EXTRA]==$AUDIO_SEPARATOR_VERSION"

"$VENV_PYTHON" - <<'PY'
from importlib import metadata
import importlib.util

print("trackextract_engine importable:", importlib.util.find_spec("trackextract_engine") is not None)
for package in ["demucs", "audio-separator"]:
    try:
        print(f"{package}: {metadata.version(package)}")
    except Exception as error:
        print(f"{package}: unavailable ({error})")

try:
    import torch
    print(f"torch: {torch.__version__}")
    print(f"cuda available: {torch.cuda.is_available()}")
except Exception as error:
    print(f"torch probe failed: {error}")
PY

echo
echo "Done. Launch TrackExtract from this repo or set:"
echo "  export TRACKEXTRACT_ENGINE_PYTHON=\"$VENV_PYTHON\""
echo "For NVIDIA CUDA, recreate with:"
echo "  TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu scripts/setup-trackextract-engine.sh"
