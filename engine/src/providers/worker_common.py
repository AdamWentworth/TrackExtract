from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ..errors import TrackExtractError
from ..schemas import stem_file


def run_worker(
    command: list[str], result_path: Path, log_path: Path, provider_name: str, job_id: str
) -> tuple[list[dict], Path]:
    completed = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if completed.returncode != 0:
        detail = read_log_tail(log_path) or f"{provider_name} exited with status {completed.returncode}"
        raise TrackExtractError(f"{provider_name} failed: {detail}")
    if not result_path.is_file():
        raise TrackExtractError(f"{provider_name} finished but did not write a result file")
    result = json.loads(result_path.read_text(encoding="utf-8"))
    return [stem_file(item["label"], Path(item["path"]), job_id) for item in result.get("stems", [])], log_path


def read_log_tail(path: Path) -> str:
    if not path.is_file():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[-1400:].strip()
