from __future__ import annotations

import os
import sys
from pathlib import Path

from .worker_common import run_worker


def run(request: dict, emit) -> tuple[list[dict], Path]:
    context = request["context"]
    job = request["job"]
    model = request["model"]
    project = request["project"]
    options = job.get("options") or {}
    runtime = model.get("runtime") or {}
    worker = Path(os.environ.get("TRACKEXTRACT_DEMUCS_WORKER") or Path(__file__).resolve().parents[1] / "workers" / "demucs_worker.py")
    logs_dir = Path(project["rootPath"]) / "logs"
    stems_dir = Path(project["rootPath"]) / "stems"
    work_dir = logs_dir / f"demucs-work-{job['id']}"
    result_path = logs_dir / f"{job['id']}.demucs-result.json"
    log_path = logs_dir / f"{job['id']}.log"

    emit(0.08, "Starting Demucs separation")
    command = [
        sys.executable,
        str(worker),
        "--input",
        job["sourcePath"],
        "--output-dir",
        str(stems_dir),
        "--work-dir",
        str(work_dir),
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
        "--model",
        runtime.get("demucsModel") or runtime.get("modelFilename") or "htdemucs",
        "--mode",
        runtime.get("demucsMode") or "vocals",
        "--device",
        options.get("device") or runtime.get("device") or "auto",
        "--shifts",
        str(options.get("demucsShifts", 1)),
        "--overlap",
        str(options.get("demucsOverlap", 0.25)),
    ]
    segment = float(options.get("demucsSegmentSeconds") or 0)
    if segment > 0:
        command.extend(["--segment", str(segment)])
    return run_worker(command, result_path, log_path, "Demucs", job["id"])
