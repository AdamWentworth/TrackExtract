from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from .errors import CancelledError, TrackExtractError
from .paths import EngineContext
from .project import add_project_job, get_current_project, replace_job_stems
from .registry import find_model, load_models
from .schemas import model_option_defaults, new_id, now_iso, read_json
from .state import load_jobs, mutate_state

ACTIVE_STATES = {"queued", "preparing", "running"}


def list_jobs(context: EngineContext) -> list[dict]:
    return load_jobs(context)


def enqueue(
    context: EngineContext, task: str, model_id: str | None, source_id: str | None, options: dict | None
) -> dict:
    session = get_current_project(context)
    if not session:
        raise TrackExtractError("No project is currently open")
    sources = available_sources(session)
    originals = session.get("originalFiles") or []
    default_source = originals[0] if originals else None
    source = (
        next((candidate for candidate in sources if candidate.get("id") == source_id), None)
        if source_id
        else default_source
    )
    if source_id and not source:
        raise TrackExtractError("Selected source is no longer available in this project")
    if not source:
        raise TrackExtractError("Project has no imported audio files")
    source_path = source.get("projectPath") or source.get("path")
    if not source_path:
        raise TrackExtractError("Selected source does not have an audio path")
    if not Path(source_path).is_file():
        raise TrackExtractError(f"Selected source file not found: {source_path}")

    model = find_model(context, model_id) if model_id else default_model_for_task(context, task)
    if not model.get("installed"):
        raise TrackExtractError(f"Model not available: {model.get('displayName')} is not installed yet")
    if task not in (model.get("tasks") or []):
        raise TrackExtractError(f"Model not available: {model.get('displayName')} does not support {task}")

    now = now_iso()
    job = {
        "id": new_id(),
        "projectId": session["id"],
        "projectName": session["name"],
        "projectSessionPath": str(Path(session["rootPath"]) / "session.json"),
        "sourceId": source["id"],
        "sourcePath": source_path,
        "task": task,
        "modelId": model["id"],
        "options": model_option_defaults(model, options),
        "state": "queued",
        "progress": 0.0,
        "statusMessage": "Queued",
        "error": None,
        "stems": [],
        "logPath": None,
        "createdAt": now,
        "updatedAt": now,
    }

    def add_to_queue(state: dict) -> dict:
        jobs = state.get("jobs") or []
        active_job = next((candidate for candidate in jobs if candidate.get("state") in ACTIVE_STATES), None)
        if active_job:
            raise TrackExtractError("A separation job is already running. Cancel it before starting another.")
        state["jobs"] = [job, *jobs]
        return job

    mutate_state(context, add_to_queue)
    add_project_job(session, job["id"])
    return job


def available_sources(session: dict) -> list[dict]:
    return [*(session.get("originalFiles") or []), *(session.get("stems") or [])]


def default_model_for_task(context: EngineContext, task: str) -> dict:
    for model in load_models(context):
        if model.get("installed") and task in (model.get("tasks") or []) and model.get("backend") != "stub":
            return model
    for model in load_models(context):
        if model.get("installed") and task in (model.get("tasks") or []):
            return model
    raise TrackExtractError(f"Model not available: {task}")


def get_job(context: EngineContext, job_id: str) -> dict:
    for job in load_jobs(context):
        if job.get("id") == job_id:
            return job
    raise TrackExtractError(f"Job not found: {job_id}")


def mutate_job(context: EngineContext, job_id: str, mutator: Callable[[dict], None]) -> dict:
    def update(state: dict) -> dict:
        jobs = state.get("jobs") or []
        job = next((candidate for candidate in jobs if candidate.get("id") == job_id), None)
        if not job:
            raise TrackExtractError(f"Job not found: {job_id}")
        mutator(job)
        job["updatedAt"] = now_iso()
        state["jobs"] = jobs
        return dict(job)

    return mutate_state(context, update)


def claim_job(context: EngineContext, job_id: str) -> dict:
    def claim(state: dict) -> dict:
        jobs = state.get("jobs") or []
        job = next((candidate for candidate in jobs if candidate.get("id") == job_id), None)
        if not job:
            raise TrackExtractError(f"Job not found: {job_id}")
        if job.get("state") == "cancelled":
            raise CancelledError("Job was cancelled before it started")
        if job.get("state") != "queued":
            raise TrackExtractError(f"Job cannot start from state: {job.get('state')}")
        competing = next(
            (
                candidate
                for candidate in jobs
                if candidate.get("id") != job_id and candidate.get("state") in ACTIVE_STATES
            ),
            None,
        )
        if competing:
            raise TrackExtractError("Another separation job is already active")
        job["state"] = "preparing"
        job["statusMessage"] = "Preparing source audio"
        job["updatedAt"] = now_iso()
        state["jobs"] = jobs
        return dict(job)

    return mutate_state(context, claim)


def set_state(context: EngineContext, job_id: str, state: str, message: str) -> dict:
    def update(job: dict) -> None:
        if job.get("state") == "cancelled":
            raise CancelledError("Job was cancelled")
        job["state"] = state
        job["statusMessage"] = message

    return mutate_job(context, job_id, update)


def set_progress(context: EngineContext, job_id: str, progress: float, message: str) -> dict:
    def update(job: dict) -> None:
        if job.get("state") == "cancelled":
            raise CancelledError("Job was cancelled")
        if job.get("state") not in {"preparing", "running"}:
            raise TrackExtractError(f"Job progress cannot change from state: {job.get('state')}")
        job["progress"] = max(0.0, min(1.0, progress))
        job["statusMessage"] = message

    return mutate_job(context, job_id, update)


def complete(context: EngineContext, job_id: str, stems: list[dict], log_path: Path) -> tuple[dict, dict]:
    def finish(job: dict) -> None:
        if job.get("state") == "cancelled":
            raise CancelledError("Job was cancelled")
        job["state"] = "complete"
        job["progress"] = 1.0
        job["statusMessage"] = "Complete"
        job["error"] = None
        job["stems"] = stems
        job["logPath"] = str(log_path)

    job = mutate_job(context, job_id, finish)
    session_path = Path(job.get("projectSessionPath") or "")
    session = read_json(session_path, None) if session_path.is_file() else None
    if not session:
        current_project = get_current_project(context)
        session = current_project if current_project and current_project.get("id") == job.get("projectId") else None
    if not session:
        raise TrackExtractError("The project associated with this job is no longer available")
    session = replace_job_stems(session, job_id, stems)
    return job, session


def fail(context: EngineContext, job_id: str, message: str) -> dict:
    def mark_failed(job: dict) -> None:
        if job.get("state") == "cancelled":
            return
        job["state"] = "failed"
        job["statusMessage"] = message
        job["error"] = message

    return mutate_job(context, job_id, mark_failed)


def cancel(context: EngineContext, job_id: str) -> dict:
    def mark_cancelled(job: dict) -> None:
        if job.get("state") not in ACTIVE_STATES:
            raise TrackExtractError(f"Job cannot be cancelled from state: {job.get('state')}")
        job["state"] = "cancelled"
        job["statusMessage"] = "Cancelled"
        job["error"] = None

    return mutate_job(context, job_id, mark_cancelled)


def clear_job_history(context: EngineContext) -> list[dict]:
    def clear(state: dict) -> list[dict]:
        active_job = next((job for job in state.get("jobs") or [] if job.get("state") in ACTIVE_STATES), None)
        if active_job:
            raise TrackExtractError("Cancel the active job before clearing job history")
        state["jobs"] = []
        return []

    mutate_state(context, clear)
    session = get_current_project(context)
    if session:
        session["jobs"] = []
        from .project import save_project

        save_project(session)
    return []
