from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class EngineContext:
    app_data_dir: Path
    project_root: Path
    repo_root: Path
    bundled_models: str
    bundled_workflows: str

    @classmethod
    def from_payload(cls, payload: dict) -> EngineContext:
        context = payload.get("context") or {}
        repo_root = Path(context.get("repoRoot") or os.getcwd()).expanduser()
        app_data = Path(context.get("appDataDir") or default_app_data_dir()).expanduser()
        project_root = Path(context.get("projectRoot") or default_project_root()).expanduser()
        return cls(
            app_data_dir=app_data,
            project_root=project_root,
            repo_root=repo_root,
            bundled_models=context.get("bundledModels") or "[]",
            bundled_workflows=context.get("bundledWorkflows") or "[]",
        )

    @property
    def models_path(self) -> Path:
        return self.app_data_dir / "models.json"

    @property
    def workflows_path(self) -> Path:
        return self.app_data_dir / "workflows.json"

    @property
    def state_path(self) -> Path:
        return self.app_data_dir / "state.json"


def default_app_data_dir() -> Path:
    home = Path.home()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local")) / "TrackExtract"
    if sys_platform() == "darwin":
        return home / "Library" / "Application Support" / "TrackExtract"
    return home / ".local" / "share" / "trackextract"


def default_project_root() -> Path:
    home = Path.home()
    music = home / "Music"
    documents = home / "Documents"
    base = music if music.exists() else documents
    return base / "TrackExtract Projects"


def sys_platform() -> str:
    import sys

    return sys.platform
