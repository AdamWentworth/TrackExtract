from __future__ import annotations

from pathlib import Path

from .errors import TrackExtractError
from .paths import EngineContext
from .project import add_project_job, get_current_project, replace_job_stems, save_project
from .registry import find_model, load_models
from .schemas import model_option_defaults, new_id, now_iso
from .state import load_jobs, save_jobs


def list_jobs(context: EngineContext) -> list[dict]:
    return load_jobs(context)


def enqueue(
    context: EngineContext, task: str, model_id: str | None, source_id: str | None, options: dict | None
) -> dict:
    session = get_current_project(context)
    if not session:
        raise TrackExtractError("No project is currently open")
    active_job = next((job for job in load_jobs(context) if job.get("state") in {"preparing", "running"}), None)
    if active_job:
        raise TrackExtractError("A separation job is already running. Cancel it before starting another.")
    sources = session.get("originalFiles") or []
    source = next(
        (candidate for candidate in sources if candidate.get("id") == source_id), sources[0] if sources else None
    )
    if not source:
        raise TrackExtractError("Project has no imported audio files")

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
        "sourceId": source["id"],
        "sourcePath": source["projectPath"],
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
    jobs = [job, *load_jobs(context)]
    save_jobs(context, jobs)
    add_project_job(session, job["id"])
    return job


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


def update_job(context: EngineContext, job: dict) -> dict:
    job["updatedAt"] = now_iso()
    jobs = [job if candidate.get("id") == job.get("id") else candidate for candidate in load_jobs(context)]
    save_jobs(context, jobs)
    return job


def set_state(context: EngineContext, job_id: str, state: str, message: str) -> dict:
    job = get_job(context, job_id)
    job["state"] = state
    job["statusMessage"] = message
    return update_job(context, job)


def set_progress(context: EngineContext, job_id: str, progress: float, message: str) -> dict:
    job = get_job(context, job_id)
    job["progress"] = max(0.0, min(1.0, progress))
    job["statusMessage"] = message
    return update_job(context, job)


def complete(context: EngineContext, job_id: str, stems: list[dict], log_path: Path) -> tuple[dict, dict]:
    job = get_job(context, job_id)
    job["state"] = "complete"
    job["progress"] = 1.0
    job["statusMessage"] = "Complete"
    job["error"] = None
    job["stems"] = stems
    job["logPath"] = str(log_path)
    update_job(context, job)
    session = get_current_project(context)
    if not session:
        raise TrackExtractError("No project is currently open")
    session = replace_job_stems(session, job_id, stems)
    return job, session


def fail(context: EngineContext, job_id: str, message: str) -> dict:
    job = get_job(context, job_id)
    job["state"] = "failed"
    job["statusMessage"] = message
    job["error"] = message
    return update_job(context, job)


def cancel(context: EngineContext, job_id: str) -> dict:
    job = get_job(context, job_id)
    job["state"] = "cancelled"
    job["statusMessage"] = "Cancelled"
    return update_job(context, job)


def clear_job_history(context: EngineContext) -> list[dict]:
    active_job = next((job for job in load_jobs(context) if job.get("state") in {"preparing", "running"}), None)
    if active_job:
        raise TrackExtractError("Cancel the running job before clearing job history")

    save_jobs(context, [])
    session = get_current_project(context)
    if session:
        session["jobs"] = []
        save_project(session)
    return []
