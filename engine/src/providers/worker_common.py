from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from ..errors import TrackExtractError
from ..schemas import stem_file


def run_worker(
    command: list[str],
    result_path: Path,
    log_path: Path,
    provider_name: str,
    job_id: str,
    emit=None,
    poll_interval: float = 5.0,
) -> tuple[list[dict], Path]:
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started_at = time.monotonic()
    last_message = ""

    try:
        while process.poll() is None:
            if emit:
                elapsed = time.monotonic() - started_at
                detail = read_log_status(log_path) or f"{provider_name} is running"
                message = f"{detail} · {format_elapsed(elapsed)} elapsed"
                if message != last_message:
                    emit(estimated_progress(elapsed), message)
                    last_message = message
            time.sleep(poll_interval)
    except BaseException:
        terminate_worker(process)
        raise

    if process.returncode != 0:
        detail = read_log_tail(log_path) or f"{provider_name} exited with status {process.returncode}"
        raise TrackExtractError(f"{provider_name} failed: {detail}")
    if not result_path.is_file():
        raise TrackExtractError(f"{provider_name} finished but did not write a result file")
    result = json.loads(result_path.read_text(encoding="utf-8"))
    return [stem_file(item["label"], Path(item["path"]), job_id) for item in result.get("stems", [])], log_path


def terminate_worker(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        completed = subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if completed.returncode == 0:
            return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def read_log_tail(path: Path) -> str:
    if not path.is_file():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[-1400:].strip()


def read_log_status(path: Path) -> str:
    if not path.is_file():
        return ""

    lines = [line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    if not lines:
        return ""

    for line in reversed(lines):
        if line.startswith(("Running ", "Separating ", "Loading ", "Decoding ", "Wrote ")):
            return line
    return lines[-1]


def estimated_progress(elapsed_seconds: float) -> float:
    # A heartbeat estimate only; completion still comes from the worker result file.
    return min(0.94, 0.10 + elapsed_seconds / 900)


def format_elapsed(elapsed_seconds: float) -> str:
    seconds = max(0, int(elapsed_seconds))
    minutes, seconds = divmod(seconds, 60)
    if minutes >= 60:
        hours, minutes = divmod(minutes, 60)
        return f"{hours}h {minutes:02d}m {seconds:02d}s"
    return f"{minutes}:{seconds:02d}"
