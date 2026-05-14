from __future__ import annotations

import os
import sys
from pathlib import Path

from ..registry import local_model_path
from .worker_common import run_worker


def run(request: dict, emit) -> tuple[list[dict], Path]:
    context = request["engineContext"]
    job = request["job"]
    model = request["model"]
    project = request["project"]
    options = job.get("options") or {}
    worker = Path(
        os.environ.get("TRACKEXTRACT_AUDIO_SEPARATOR_WORKER")
        or Path(__file__).resolve().parents[1] / "workers" / "audio_separator_worker.py"
    )
    model_path = local_model_path(context, model)
    if not model_path:
        raise RuntimeError(f"{model['displayName']} does not have an installed local model file")
    if model_path.suffix.lower() == ".th":
        raise RuntimeError(f"{model['displayName']} needs a YAML model definition before it can run")

    logs_dir = Path(project["rootPath"]) / "logs"
    stems_dir = Path(project["rootPath"]) / "stems"
    result_path = logs_dir / f"{job['id']}.audio-separator-result.json"
    log_path = logs_dir / f"{job['id']}.log"
    emit(0.08, "Starting Audio Separator")
    command = [
        sys.executable,
        str(worker),
        "--input",
        job["sourcePath"],
        "--output-dir",
        str(stems_dir),
        "--model-file-dir",
        str(model_path.parent),
        "--model-filename",
        model_path.name,
        "--result-json",
        str(result_path),
        "--log-path",
        str(log_path),
        "--project-name",
        project["name"],
        "--job-id",
        job["id"],
        "--task",
        job["task"],
        "--stems-json",
        __import__("json").dumps(model.get("stems") or []),
        "--sample-rate",
        str(model.get("sampleRate") or 44100),
        "--device",
        options.get("device") or (model.get("runtime") or {}).get("device") or "auto",
        "--mdx-segment-size",
        str(options.get("mdxSegmentSize") or options.get("chunkSize") or 256),
        "--mdx-overlap",
        str(options.get("mdxOverlap") or options.get("overlap") or 0.25),
        "--batch-size",
        str(options.get("batchSize") or 1),
    ]
    if options.get("enableDenoisePass"):
        command.append("--enable-denoise-pass")
    return run_worker(command, result_path, log_path, "Audio Separator", job["id"])
