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

echo "Creating Track Extract Python engine environment at $VENV_DIR"
trackextract_prepare_python_venv "$VENV_DIR" "${PYTHON:-python3}"
"$VENV_PYTHON" -m pip install --upgrade pip wheel

if [[ "$AUDIO_SEPARATOR_EXTRA" == "gpu" ]]; then
  # PyPI's default torch wheel is CPU-only. CUDA 11.8 retains compatibility
  # with Pascal-generation NVIDIA GPUs while satisfying our provider versions.
  "$VENV_PYTHON" -m pip install --upgrade \
    torch==2.7.1 torchvision==0.22.1 torchaudio==2.7.1 \
    --index-url https://download.pytorch.org/whl/cu118
  "$VENV_PYTHON" -m pip install \
    --constraint "$ROOT_DIR/engine/constraints-runtime-gpu.txt" \
    -e "$ROOT_DIR/engine[runtime-$AUDIO_SEPARATOR_EXTRA]"
else
  "$VENV_PYTHON" -m pip install -e "$ROOT_DIR/engine[runtime-$AUDIO_SEPARATOR_EXTRA]"
fi

"$VENV_PYTHON" "$ROOT_DIR/scripts/probe-trackextract-runtime.py" \
  --expect "$AUDIO_SEPARATOR_EXTRA"

echo
echo "Done. Launch Track Extract from this repo or set:"
echo "  export TRACKEXTRACT_ENGINE_PYTHON=\"$VENV_PYTHON\""
echo "For NVIDIA CUDA, install/update with:"
echo "  TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu scripts/setup-trackextract-engine.sh"
echo "For Windows DirectML, install/update with:"
echo "  TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=dml scripts/setup-trackextract-engine.sh"
