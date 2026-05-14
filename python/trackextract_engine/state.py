from __future__ import annotations

from pathlib import Path

from .paths import EngineContext
from .schemas import read_json, write_json


def load_state(context: EngineContext) -> dict:
    return read_json(context.state_path, {"currentProjectPath": None, "jobs": []})


def save_state(context: EngineContext, state: dict) -> None:
    write_json(context.state_path, state)


def current_project_path(context: EngineContext) -> Path | None:
    state = load_state(context)
    path = state.get("currentProjectPath")
    if path and Path(path).is_file():
        return Path(path)
    latest = latest_project_session(context.project_root)
    if latest:
        state["currentProjectPath"] = str(latest)
        save_state(context, state)
    return latest


def latest_project_session(project_root: Path) -> Path | None:
    if not project_root.exists():
        return None
    sessions = [path for path in project_root.glob("*/session.json") if path.is_file()]
    if not sessions:
        return None
    return max(sessions, key=lambda path: path.stat().st_mtime)


def set_current_project(context: EngineContext, session_path: Path, jobs: list[dict] | None = None) -> None:
    state = load_state(context)
    state["currentProjectPath"] = str(session_path)
    if jobs is not None:
        state["jobs"] = jobs
    save_state(context, state)


def load_jobs(context: EngineContext) -> list[dict]:
    return load_state(context).get("jobs") or []


def save_jobs(context: EngineContext, jobs: list[dict]) -> None:
    state = load_state(context)
    state["jobs"] = jobs
    save_state(context, state)
