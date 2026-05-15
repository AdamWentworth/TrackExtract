from __future__ import annotations

import json
import shutil
import subprocess
import wave
from pathlib import Path

from .errors import TrackExtractError
from .paths import EngineContext
from .schemas import new_id, now_iso, read_json, write_json
from .state import current_project_path, load_jobs, save_jobs, set_current_project

SESSION_SCHEMA_VERSION = 1
EXPORT_FORMATS = {
    "wav": {
        "extension": ".wav",
        "ffmpeg_args": ["-c:a", "pcm_s16le"],
    },
    "flac": {
        "extension": ".flac",
        "ffmpeg_args": ["-c:a", "flac", "-compression_level", "8"],
    },
    "mp3": {
        "extension": ".mp3",
        "ffmpeg_args": ["-c:a", "libmp3lame", "-b:a", "320k"],
    },
    "m4a": {
        "extension": ".m4a",
        "ffmpeg_args": ["-c:a", "aac", "-b:a", "256k"],
    },
    "aiff": {
        "extension": ".aiff",
        "ffmpeg_args": ["-c:a", "pcm_s16be"],
    },
}


def import_audio_files(context: EngineContext, paths: list[str]) -> dict:
    if not paths:
        raise TrackExtractError("Project has no imported audio files")
    source_paths = [Path(path).expanduser() for path in paths]
    missing = [path for path in source_paths if not path.is_file()]
    if missing:
        raise TrackExtractError(f"File not found: {missing[0]}")

    context.project_root.mkdir(parents=True, exist_ok=True)
    name = sanitize_name(source_paths[0].stem or "Untitled Track")
    existing_session = find_existing_project_for_sources(context, name, source_paths)
    if existing_session:
        existing_session = refresh_imported_sources(existing_session, source_paths)
        save_project(existing_session)
        session_path = Path(existing_session["rootPath"]) / "session.json"
        if current_project_path(context) == session_path:
            set_current_project(context, session_path)
        else:
            set_current_project(context, session_path, jobs=[])
        return existing_session

    root_path = reusable_project_path(context.project_root, name) or unique_project_path(context.project_root, name)
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
    session = read_json(path, None)
    return refresh_project_metadata(session) if session else None


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


def export_stems(
    context: EngineContext,
    stem_ids: list[str],
    destination_path: str | None,
    export_format: str = "wav",
) -> list[str]:
    session = get_current_project(context)
    if not session:
        raise TrackExtractError("No project is currently open")
    format_key = normalize_export_format(export_format)
    destination = (
        Path(destination_path).expanduser() if destination_path else Path(session["rootPath"]) / "renders" / "exports"
    )
    destination.mkdir(parents=True, exist_ok=True)
    stems = session.get("stems") or []
    selected = stems if not stem_ids else [stem for stem in stems if stem.get("id") in stem_ids]
    exported = []
    for stem in selected:
        source = Path(stem["path"])
        output = destination / daw_friendly_stem_filename(
            session.get("name") or "Track Extract",
            stem.get("label") or source.stem,
            format_key,
        )
        export_audio_file(source, output, format_key)
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


def delete_project_stem(context: EngineContext, stem_id: str | None) -> dict:
    session = require_current_project(context)
    ensure_no_active_jobs(context)
    if not stem_id:
        raise TrackExtractError("Choose a stem to delete")

    stems = session.get("stems") or []
    stem = next((candidate for candidate in stems if candidate.get("id") == stem_id), None)
    if not stem:
        raise TrackExtractError("Stem not found in the current project")

    root_path = Path(session["rootPath"])
    stems_dir = root_path / "stems"
    stem_path = Path(stem.get("path") or "")
    if stem_path and is_within(stems_dir, stem_path):
        stem_path.unlink(missing_ok=True)

    session["stems"] = [candidate for candidate in stems if candidate.get("id") != stem_id]
    save_project(session)

    source_job_id = stem.get("sourceJobId")
    if source_job_id:
        jobs = []
        for job in load_jobs(context):
            if job.get("id") == source_job_id:
                job_stems = [candidate for candidate in job.get("stems", []) if candidate.get("id") != stem_id]
                job = {**job, "stems": job_stems, "updatedAt": now_iso()}
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


def daw_friendly_stem_filename(project_name: str, stem_label: str, export_format: str = "wav") -> str:
    format_key = normalize_export_format(export_format)
    return f"{sanitize_name(project_name)} - {sanitize_name(stem_label)}{EXPORT_FORMATS[format_key]['extension']}"


def normalize_export_format(export_format: str | None) -> str:
    format_key = (export_format or "wav").lower().strip().lstrip(".")
    if format_key == "aif":
        format_key = "aiff"
    if format_key not in EXPORT_FORMATS:
        supported = ", ".join(EXPORT_FORMATS)
        raise TrackExtractError(f"Unsupported export format: {export_format}. Choose one of: {supported}.")
    return format_key


def export_audio_file(source: Path, output: Path, export_format: str) -> None:
    if not source.is_file():
        raise TrackExtractError(f"Stem file is missing: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    format_key = normalize_export_format(export_format)
    if format_key == "wav" and source.suffix.lower() == ".wav":
        shutil.copy2(source, output)
        return

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise TrackExtractError("Exporting to this audio format requires ffmpeg. Run the engine setup script again.")

    try:
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(source),
                *EXPORT_FORMATS[format_key]["ffmpeg_args"],
                str(output),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        message = (error.stderr or "").strip() or f"ffmpeg could not export {source.name}"
        raise TrackExtractError(message) from error


def unique_project_path(parent: Path, base_name: str) -> Path:
    candidate = parent / base_name
    suffix = 2
    while candidate.exists():
        candidate = parent / f"{base_name} {suffix}"
        suffix += 1
    return candidate


def reusable_project_path(parent: Path, base_name: str) -> Path | None:
    candidate = parent / base_name
    session_path = candidate / "session.json"
    if not session_path.is_file():
        return None
    session = read_json(session_path, None) or {}
    if session.get("originalFiles") or session.get("stems") or session.get("jobs"):
        return None
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


def find_existing_project_for_sources(context: EngineContext, name: str, source_paths: list[Path]) -> dict | None:
    requested = [canonical_path(path) for path in source_paths]
    current_path = current_project_path(context)
    matches = []

    for session_path in project_session_paths(context.project_root):
        session = read_json(session_path, None)
        if not session or session.get("name") != name:
            continue
        existing = [canonical_path(Path(source.get("sourcePath", ""))) for source in session.get("originalFiles") or []]
        if existing == requested:
            matches.append((session_path, session))

    if current_path:
        for session_path, session in matches:
            if session_path == current_path:
                return session

    if not matches:
        return None

    matches.sort(key=lambda item: project_path_sort_key(Path(item[1].get("rootPath") or item[0].parent)))
    return matches[0][1]


def project_session_paths(project_root: Path) -> list[Path]:
    if not project_root.exists():
        return []
    return sorted(path for path in project_root.glob("*/session.json") if path.is_file())


def project_path_sort_key(path: Path) -> tuple[int, str]:
    name = path.name
    parts = name.rsplit(" ", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return (int(parts[1]), name)
    return (1, name)


def canonical_path(path: Path) -> str:
    try:
        return str(path.expanduser().resolve())
    except OSError:
        return str(path.expanduser().absolute())


def refresh_imported_sources(session: dict, source_paths: list[Path]) -> dict:
    root_path = Path(session["rootPath"])
    for child in ["original", "stems", "renders", "logs"]:
        (root_path / child).mkdir(parents=True, exist_ok=True)

    sources = session.get("originalFiles") or []
    source_by_path = {canonical_path(Path(source.get("sourcePath", ""))): source for source in sources}
    refreshed_sources = []
    for source_path in source_paths:
        source = source_by_path.get(canonical_path(source_path))
        if not source:
            continue
        project_path = Path(source.get("projectPath") or "")
        if not project_path.is_file():
            project_path = unique_file_path(root_path / "original", source_path.name)
            shutil.copy2(source_path, project_path)
            source["projectPath"] = str(project_path)
        refreshed_sources.append(source)

    if refreshed_sources:
        session["originalFiles"] = refreshed_sources

    return refresh_project_metadata(session)


def refresh_project_metadata(session: dict) -> dict:
    changed = False
    for source in session.get("originalFiles") or []:
        if source.get("sampleRate") and source.get("channels") and source.get("durationSeconds"):
            continue
        audio_path = Path(source.get("projectPath") or source.get("sourcePath") or "")
        metadata = read_audio_metadata(audio_path)
        for key in ["sampleRate", "channels", "durationSeconds"]:
            if metadata.get(key) is not None and source.get(key) != metadata[key]:
                source[key] = metadata[key]
                changed = True

    if changed:
        save_project(session)
    return session


def read_audio_metadata(path: Path) -> dict:
    if not path.is_file():
        return empty_audio_metadata()
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
        pass

    metadata = read_audio_metadata_with_soundfile(path)
    if metadata["sampleRate"]:
        return metadata

    return read_audio_metadata_with_ffprobe(path)


def empty_audio_metadata() -> dict:
    return {"sampleRate": None, "channels": None, "durationSeconds": None}


def read_audio_metadata_with_soundfile(path: Path) -> dict:
    try:
        import soundfile as sf

        info = sf.info(str(path))
        return {
            "sampleRate": int(info.samplerate) if info.samplerate else None,
            "channels": int(info.channels) if info.channels else None,
            "durationSeconds": (float(info.frames) / float(info.samplerate))
            if info.frames and info.samplerate
            else None,
        }
    except Exception:
        return empty_audio_metadata()


def read_audio_metadata_with_ffprobe(path: Path) -> dict:
    ffprobe = find_ffprobe()
    if not ffprobe:
        return empty_audio_metadata()

    try:
        completed = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=sample_rate,channels,duration",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=20,
        )
        payload = json.loads(completed.stdout or "{}")
        stream = next(iter(payload.get("streams") or []), {})
        duration = stream.get("duration") or (payload.get("format") or {}).get("duration")
        sample_rate = stream.get("sample_rate")
        channels = stream.get("channels")
        return {
            "sampleRate": int(sample_rate) if sample_rate else None,
            "channels": int(channels) if channels else None,
            "durationSeconds": float(duration) if duration else None,
        }
    except Exception:
        return empty_audio_metadata()


def find_ffprobe() -> str | None:
    if ffprobe := shutil.which("ffprobe"):
        return ffprobe
    try:
        import static_ffmpeg

        static_ffmpeg.add_paths(weak=True)
    except Exception:
        pass
    return shutil.which("ffprobe")


def find_ffmpeg() -> str | None:
    if ffmpeg := shutil.which("ffmpeg"):
        return ffmpeg
    try:
        import static_ffmpeg

        static_ffmpeg.add_paths(weak=True)
    except Exception:
        pass
    return shutil.which("ffmpeg")
