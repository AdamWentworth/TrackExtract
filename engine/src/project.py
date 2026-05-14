from __future__ import annotations

import shutil
import wave
from pathlib import Path

from .errors import TrackExtractError
from .paths import EngineContext
from .schemas import new_id, now_iso, read_json, write_json
from .state import current_project_path, load_jobs, save_jobs, set_current_project

SESSION_SCHEMA_VERSION = 1


def import_audio_files(context: EngineContext, paths: list[str]) -> dict:
    if not paths:
        raise TrackExtractError("Project has no imported audio files")
    source_paths = [Path(path).expanduser() for path in paths]
    missing = [path for path in source_paths if not path.is_file()]
    if missing:
        raise TrackExtractError(f"File not found: {missing[0]}")

    context.project_root.mkdir(parents=True, exist_ok=True)
    name = sanitize_name(source_paths[0].stem or "Untitled Track")
    root_path = unique_project_path(context.project_root, name)
    for child in ["original", "stems", "renders", "logs"]:
        (root_path / child).mkdir(parents=True, exist_ok=True)

    now = now_iso()
    session = {
        "schemaVersion": SESSION_SCHEMA_VERSION,
        "id": new_id(),
        "name": name,
        "rootPath": str(root_path),
        "createdAt": now,
        "updatedAt": now,
        "originalFiles": [],
        "jobs": [],
        "stems": [],
    }

    for source_path in source_paths:
        destination = unique_file_path(root_path / "original", source_path.name)
        shutil.copy2(source_path, destination)
        metadata = read_audio_metadata(destination)
        session["originalFiles"].append(
            {
                "id": new_id(),
                "originalName": source_path.name,
                "sourcePath": str(source_path),
                "projectPath": str(destination),
                "sampleRate": metadata.get("sampleRate"),
                "channels": metadata.get("channels"),
                "durationSeconds": metadata.get("durationSeconds"),
            }
        )

    save_project(session)
    set_current_project(context, root_path / "session.json", jobs=[])
    return session


def get_current_project(context: EngineContext) -> dict | None:
    path = current_project_path(context)
    if not path:
        return None
    return read_json(path, None)


def save_project(session: dict) -> None:
    session["updatedAt"] = now_iso()
    write_json(Path(session["rootPath"]) / "session.json", session)


def replace_job_stems(session: dict, job_id: str, stems: list[dict]) -> dict:
    session["stems"] = [stem for stem in session.get("stems", []) if stem.get("sourceJobId") != job_id]
    session["stems"].extend(stems)
    save_project(session)
    return session


def add_project_job(session: dict, job_id: str) -> dict:
    jobs = session.setdefault("jobs", [])
    if job_id not in jobs:
        jobs.append(job_id)
    save_project(session)
    return session


def export_stems(context: EngineContext, stem_ids: list[str], destination_path: str) -> list[str]:
    session = get_current_project(context)
    if not session:
        raise TrackExtractError("No project is currently open")
    destination = Path(destination_path).expanduser()
    destination.mkdir(parents=True, exist_ok=True)
    stems = session.get("stems") or []
    selected = stems if not stem_ids else [stem for stem in stems if stem.get("id") in stem_ids]
    exported = []
    for stem in selected:
        source = Path(stem["path"])
        output = destination / source.name
        shutil.copy2(source, output)
        exported.append(str(output))
    return exported


def clear_project_stems(context: EngineContext) -> dict:
    session = require_current_project(context)
    ensure_no_active_jobs(context)
    root_path = Path(session["rootPath"])
    source_job_ids = {stem.get("sourceJobId") for stem in session.get("stems", []) if stem.get("sourceJobId")}

    clear_project_child_directory(root_path, "stems")
    session["stems"] = []
    save_project(session)

    if source_job_ids:
        jobs = []
        for job in load_jobs(context):
            if job.get("id") in source_job_ids:
                job = {**job, "stems": [], "updatedAt": now_iso()}
            jobs.append(job)
        save_jobs(context, jobs)

    return session


def clear_project_source(context: EngineContext) -> dict:
    session = require_current_project(context)
    ensure_no_active_jobs(context)
    root_path = Path(session["rootPath"])

    clear_project_child_directory(root_path, "original")
    clear_project_child_directory(root_path, "stems")
    clear_project_child_directory(root_path, "renders")

    session["originalFiles"] = []
    session["jobs"] = []
    session["stems"] = []
    save_project(session)
    set_current_project(context, root_path / "session.json", jobs=[])
    return session


def require_current_project(context: EngineContext) -> dict:
    session = get_current_project(context)
    if not session:
        raise TrackExtractError("No project is currently open")
    return session


def ensure_no_active_jobs(context: EngineContext) -> None:
    active = next((job for job in load_jobs(context) if job.get("state") in {"preparing", "running"}), None)
    if active:
        raise TrackExtractError("Cancel the running job before clearing workspace files")


def clear_project_child_directory(root_path: Path, child_name: str) -> None:
    target = root_path / child_name
    if not target.exists():
        target.mkdir(parents=True, exist_ok=True)
        return
    if not is_within(root_path, target):
        raise TrackExtractError(f"Refusing to clear a folder outside this project: {target}")

    for child in target.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink(missing_ok=True)


def is_within(parent: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def sanitize_name(value: str) -> str:
    invalid = set('/\\:*?"<>|')
    cleaned = "".join("-" if character in invalid or ord(character) < 32 else character for character in value)
    cleaned = " ".join(cleaned.split()).strip(". -")
    return cleaned or "Untitled Track"


def daw_friendly_stem_filename(project_name: str, stem_label: str) -> str:
    return f"{sanitize_name(project_name)} - {sanitize_name(stem_label)}.wav"


def unique_project_path(parent: Path, base_name: str) -> Path:
    candidate = parent / base_name
    suffix = 2
    while candidate.exists():
        candidate = parent / f"{base_name} {suffix}"
        suffix += 1
    return candidate


def unique_file_path(parent: Path, file_name: str) -> Path:
    candidate = parent / file_name
    if not candidate.exists():
        return candidate
    source = Path(file_name)
    stem = source.stem or "audio"
    suffix = source.suffix
    index = 2
    while True:
        candidate = parent / f"{stem} {index}{suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def read_audio_metadata(path: Path) -> dict:
    if path.suffix.lower() != ".wav":
        return {"sampleRate": None, "channels": None, "durationSeconds": None}
    try:
        with wave.open(str(path), "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate()
            return {
                "sampleRate": rate,
                "channels": wav.getnchannels(),
                "durationSeconds": frames / rate if rate else None,
            }
    except Exception:
        return {"sampleRate": None, "channels": None, "durationSeconds": None}
