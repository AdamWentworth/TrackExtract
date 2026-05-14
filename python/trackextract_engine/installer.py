from __future__ import annotations

import subprocess
import sys
import urllib.request
from pathlib import Path

from .errors import TrackExtractError
from .paths import EngineContext
from .registry import load_models, save_models


def install_model(context: EngineContext, model_id: str, emit) -> dict:
    models = load_models(context)
    model = next((candidate for candidate in models if candidate.get("id") == model_id), None)
    if not model:
        raise TrackExtractError(f"Model not available: {model_id}")

    method = model.get("installMethod") or infer_install_method(model)
    if method == "source-only":
        raise TrackExtractError(f"{model['displayName']} is a source reference and does not have a managed local install yet")
    if method == "audio-separator" and not model.get("downloadUrl"):
        prefetch_audio_separator_model(context, model, emit)
    else:
        download_direct_model(context, model, emit)

    model["installed"] = True
    save_models(context, models)
    emit(
        "models_updated",
        models,
    )
    return model


def infer_install_method(model: dict) -> str:
    if model.get("downloadUrl") and str(model.get("path", "")).startswith("models/"):
        return "direct-url"
    if (model.get("runtime") or {}).get("provider") == "audio-separator":
        return "audio-separator"
    return "source-only"


def download_direct_model(context: EngineContext, model: dict, emit) -> None:
    url = model.get("downloadUrl")
    path = model.get("path")
    if not url or not path:
        raise TrackExtractError(f"{model['displayName']} does not have a managed download yet")
    destination = context.app_data_dir / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_suffix(destination.suffix + ".download")

    expected_total = int(model.get("downloadSizeMb") or 0) * 1024 * 1024 or None
    emit_progress(emit, model, 0, 0, expected_total, f"Downloading {model['displayName']}")
    with urllib.request.urlopen(url) as response, temp.open("wb") as output:
        total = int(response.headers.get("Content-Length") or expected_total or 0) or None
        downloaded = 0
        while True:
            chunk = response.read(1024 * 512)
            if not chunk:
                break
            output.write(chunk)
            downloaded += len(chunk)
            progress = downloaded / total if total else 0
            emit_progress(emit, model, progress, downloaded, total, f"Downloading {model['displayName']}")
    temp.replace(destination)
    emit_progress(emit, model, 1, destination.stat().st_size, destination.stat().st_size, f"Installed {model['displayName']}")


def prefetch_audio_separator_model(context: EngineContext, model: dict, emit) -> None:
    runtime = model.get("runtime") or {}
    filename = runtime.get("modelFilename")
    if not filename:
        raise TrackExtractError(f"{model['displayName']} is missing an audio-separator model filename")
    model_dir = context.app_data_dir / "models" / "audio-separator"
    model_dir.mkdir(parents=True, exist_ok=True)
    emit_progress(emit, model, 0, 0, None, f"Prefetching {model['displayName']}")
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "audio_separator.utils.cli",
            "--download_model_only",
            "--model_filename",
            filename,
            "--model_file_dir",
            str(model_dir),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise TrackExtractError(completed.stderr.strip() or f"audio-separator could not download {filename}")
    model["path"] = str(Path("models") / "audio-separator" / filename)
    emit_progress(emit, model, 1, 0, None, f"Installed {model['displayName']}")


def emit_progress(emit, model: dict, progress: float, bytes_downloaded: int, total_bytes: int | None, message: str) -> None:
    emit(
        "model_download_progress",
        {
            "modelId": model["id"],
            "progress": max(0.0, min(1.0, progress)),
            "bytesDownloaded": bytes_downloaded,
            "totalBytes": total_bytes,
            "message": message,
        },
    )
