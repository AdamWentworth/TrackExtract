from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from .paths import EngineContext
from .schemas import file_lock, read_json, write_json

T = TypeVar("T")


def load_state(context: EngineContext) -> dict:
    return read_json(context.state_path, {"currentProjectPath": None, "jobs": []})


def save_state(context: EngineContext, state: dict) -> None:
    with file_lock(state_lock_path(context)):
        write_json(context.state_path, state)


def mutate_state(context: EngineContext, mutator: Callable[[dict], T]) -> T:
    with file_lock(state_lock_path(context)):
        state = load_state(context)
        result = mutator(state)
        write_json(context.state_path, state)
        return result


def state_lock_path(context: EngineContext) -> Path:
    return context.state_path.with_suffix(f"{context.state_path.suffix}.lock")


def current_project_path(context: EngineContext) -> Path | None:
    state = load_state(context)
    path = state.get("currentProjectPath")
    if path and Path(path).is_file():
        return Path(path)
    latest = latest_project_session(context.project_root)
    if latest:

        def select_latest(current: dict) -> None:
            current["currentProjectPath"] = str(latest)

        mutate_state(context, select_latest)
    return latest


def latest_project_session(project_root: Path) -> Path | None:
    if not project_root.exists():
        return None
    sessions = [path for path in project_root.glob("*/session.json") if path.is_file()]
    if not sessions:
        return None
    return max(sessions, key=lambda path: path.stat().st_mtime)


def set_current_project(context: EngineContext, session_path: Path, jobs: list[dict] | None = None) -> None:
    def update(state: dict) -> None:
        state["currentProjectPath"] = str(session_path)
        if jobs is not None:
            state["jobs"] = jobs

    mutate_state(context, update)


def load_jobs(context: EngineContext) -> list[dict]:
    return load_state(context).get("jobs") or []


def save_jobs(context: EngineContext, jobs: list[dict]) -> None:
    def update(state: dict) -> None:
        state["jobs"] = jobs

    mutate_state(context, update)
