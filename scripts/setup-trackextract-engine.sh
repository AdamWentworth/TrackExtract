#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${TRACKEXTRACT_ENGINE_VENV:-"$ROOT_DIR/.venv-trackextract-engine"}"
AUDIO_SEPARATOR_EXTRA="${TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA:-cpu}"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/python-env.sh"

case "$AUDIO_SEPARATOR_EXTRA" in
  cpu | gpu | dml) ;;
  *)
    echo "TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA must be one of: cpu, gpu, dml" >&2
    exit 1
    ;;
esac

echo "Creating TrackExtract Python engine environment at $VENV_DIR"
trackextract_prepare_python_venv "$VENV_DIR" "${PYTHON:-python3}"
"$VENV_PYTHON" -m pip install --upgrade pip wheel
"$VENV_PYTHON" -m pip install -e "$ROOT_DIR/engine[runtime-$AUDIO_SEPARATOR_EXTRA]"

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
echo "For NVIDIA CUDA, install/update with:"
echo "  TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu scripts/setup-trackextract-engine.sh"
echo "For Windows DirectML, install/update with:"
echo "  TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=dml scripts/setup-trackextract-engine.sh"
