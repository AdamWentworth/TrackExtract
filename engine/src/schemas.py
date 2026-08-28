from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TASK_LABELS = {
    "vocals_instrumental": "Vocals / Instrumental",
    "full_stem_split": "Full Stem Split",
    "drums_only": "Drums Only",
    "bass_only": "Bass Only",
    "guitar_only": "Guitar Only",
    "piano_only": "Piano Only",
    "experimental_best_quality": "Experimental / Best Quality",
    "vocal_cleanup_chain": "Clean Lead Vocal",
    "layered_vocal_cleanup": "Remove Layered Vocals",
    "vocal_dereverb": "Dereverb Vocal",
    "vocal_denoise": "Denoise Vocal",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_id() -> str:
    return str(uuid.uuid4())


def read_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def file_lock(path: Path, timeout: float = 15.0):
    """Serialize state changes across the short-lived engine CLI processes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = path.open("a+b")
    if lock_file.tell() == 0:
        lock_file.write(b"0")
        lock_file.flush()
    deadline = time.monotonic() + timeout
    acquired = False
    try:
        while not acquired:
            try:
                lock_file.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for state lock: {path}")
                time.sleep(0.025)
        yield
    finally:
        if acquired:
            lock_file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def stem_file(label: str, path: Path, source_job_id: str) -> dict:
    return {
        "id": new_id(),
        "label": label,
        "path": str(path),
        "sourceJobId": source_job_id,
        "muted": False,
        "solo": False,
        "volume": 1.0,
    }


def model_option_defaults(model: dict, overrides: dict | None) -> dict:
    provided = overrides or {}
    resolved = {}
    for option in model.get("options") or []:
        option_id = option["id"]
        resolved[option_id] = coerce_option(option, provided.get(option_id, option.get("defaultValue")))
    return resolved


def coerce_option(option: dict, value: Any) -> Any:
    option_type = option.get("type")
    if option_type == "boolean":
        return bool(value)
    if option_type == "integer":
        value = int(round(float(value)))
        if "min" in option:
            value = max(int(option["min"]), value)
        if "max" in option:
            value = min(int(option["max"]), value)
        return value
    if option_type == "number":
        value = float(value)
        if "min" in option:
            value = max(float(option["min"]), value)
        if "max" in option:
            value = min(float(option["max"]), value)
        return value
    if option_type == "select":
        selected = str(value)
        choices = option.get("choices") or []
        if choices and not any(choice.get("value") == selected for choice in choices):
            return str(option.get("defaultValue"))
        return selected
    return value
