from __future__ import annotations

import time
import wave
from pathlib import Path

from ..project import daw_friendly_stem_filename
from ..schemas import stem_file


def run(request: dict, emit) -> tuple[list[dict], Path]:
    job = request["job"]
    model = request["model"]
    project = request["project"]
    stems_dir = Path(project["rootPath"]) / "stems"
    logs_dir = Path(project["rootPath"]) / "logs"
    stems_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / f"{job['id']}.log"
    labels = model.get("stems") or ["Vocals", "Instrumental"]
    source_info = wav_info(Path(job["sourcePath"]))

    with log_path.open("w", encoding="utf-8") as log:
        log.write(f"TrackExtract Python stub job {job['id']}\n")
        log.write(f"Input: {job['sourcePath']}\n")
        log.write(f"Model: {model['displayName']}\n")

    rendered = []
    for index, label in enumerate(labels):
        emit(0.12 + index / max(len(labels), 1) * 0.78, f"Rendering placeholder {label}")
        destination = stems_dir / daw_friendly_stem_filename(project["name"], label)
        write_silence(destination, source_info["sampleRate"], source_info["channels"], source_info["frames"])
        rendered.append(stem_file(label, destination, job["id"]))
        time.sleep(0.05)

    return rendered, log_path


def wav_info(path: Path) -> dict:
    try:
        with wave.open(str(path), "rb") as wav:
            return {
                "sampleRate": wav.getframerate(),
                "channels": wav.getnchannels(),
                "frames": min(max(wav.getnframes(), 512), wav.getframerate() * 10),
            }
    except Exception:
        return {"sampleRate": 44100, "channels": 2, "frames": 44100}


def write_silence(path: Path, sample_rate: int, channels: int, frames: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * frames * channels)
