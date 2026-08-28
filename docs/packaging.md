# Packaging

Track Extract currently uses a managed development Python environment rather than bundled Python packaging.

Create the engine environment with:

```bash
scripts/setup-trackextract-engine.sh
```

```powershell
scripts/setup-trackextract-engine.ps1
```

Tauri auto-detects `.venv-trackextract-engine/bin/python` or `.venv-trackextract-engine/Scripts/python.exe` when launched from this repo. To force a specific interpreter:

```bash
export TRACKEXTRACT_ENGINE_PYTHON=/absolute/path/to/python
```

For audio-separator acceleration experiments:

```bash
TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=gpu scripts/setup-trackextract-engine.sh
TRACKEXTRACT_AUDIO_SEPARATOR_EXTRA=dml scripts/setup-trackextract-engine.sh
```

```powershell
scripts/setup-trackextract-engine.ps1 -Runtime gpu
scripts/setup-trackextract-engine.ps1 -Runtime dml
```

The script installs the Python package from `engine/pyproject.toml` with one of
the runtime extras: `runtime-cpu`, `runtime-gpu`, or `runtime-dml`. There is no
committed virtual environment and no separate `requirements.txt`; dependency
ownership stays with the Python package metadata.

The NVIDIA setup path additionally installs a constrained, mutually compatible
PyTorch/TorchAudio/TorchVision trio from PyTorch's CUDA 11.8 wheel index. The
setup is considered successful only after CUDA tensor execution, the ONNX CUDA
provider, and bundled FFmpeg have all been verified.

Future production packaging should decide how to bundle Python, provider dependencies, model cache directories, and hardware-specific acceleration packages per platform.

## Project Output

Projects use predictable DAW-friendly folders:

```text
Track Extract Projects/
  Artist - Song/
    original/
    stems/
      Artist - Song - Vocals.wav
      Artist - Song - Drums.wav
      Artist - Song - Bass.wav
      Artist - Song - Guitar.wav
      Artist - Song - Piano.wav
      Artist - Song - Other.wav
    renders/
    logs/
    session.json
```
