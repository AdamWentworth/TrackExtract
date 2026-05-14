from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .errors import TrackExtractError
from .paths import EngineContext
from .schemas import read_json, write_json

DEPRECATED_MODEL_IDS = {
    "stub_full_stem_split",
    "stub_vocals_instrumental",
    "onnx_roformer_full_split_placeholder",
    "onnx_mdx_vocals_placeholder",
    "pytorch_demucs_experimental_placeholder",
}


def bootstrap_registries(context: EngineContext) -> tuple[list[dict], list[dict]]:
    context.app_data_dir.mkdir(parents=True, exist_ok=True)
    context.project_root.mkdir(parents=True, exist_ok=True)

    bundled_models = [migrate_model(model) for model in json.loads(context.bundled_models)]
    bundled_workflows = json.loads(context.bundled_workflows)

    if not context.models_path.exists():
        write_json(context.models_path, bundled_models)
    if not context.workflows_path.exists():
        write_json(context.workflows_path, bundled_workflows)

    models = sync_models([migrate_model(model) for model in read_json(context.models_path, [])], bundled_models)
    workflows = sync_workflows(read_json(context.workflows_path, []), bundled_workflows)
    refresh_installed_status(context, models)
    write_json(context.models_path, models)
    write_json(context.workflows_path, workflows)
    return models, workflows


def load_models(context: EngineContext) -> list[dict]:
    bootstrap_registries(context)
    models = [migrate_model(model) for model in read_json(context.models_path, [])]
    refresh_installed_status(context, models)
    write_json(context.models_path, models)
    return models


def load_workflows(context: EngineContext) -> list[dict]:
    bootstrap_registries(context)
    return read_json(context.workflows_path, [])


def save_models(context: EngineContext, models: list[dict]) -> None:
    write_json(context.models_path, models)


def save_workflows(context: EngineContext, workflows: list[dict]) -> None:
    write_json(context.workflows_path, workflows)


def find_model(context: EngineContext, model_id: str) -> dict:
    for model in load_models(context):
        if model.get("id") == model_id:
            return model
    raise TrackExtractError(f"Model not available: {model_id}")


def sync_models(local: list[dict], bundled: list[dict]) -> list[dict]:
    local = [model for model in local if model.get("id") not in DEPRECATED_MODEL_IDS]
    by_id = {model["id"]: model for model in local if model.get("id")}

    for bundled_model in bundled:
        model_id = bundled_model.get("id")
        if not model_id or model_id in DEPRECATED_MODEL_IDS:
            continue
        existing = by_id.get(model_id)
        if existing:
            installed = existing.get("installed", bundled_model.get("installed", False))
            merged = {**bundled_model, **preserve_local_install_fields(existing)}
            merged["installed"] = installed
            by_id[model_id] = migrate_model(merged)
        else:
            by_id[model_id] = migrate_model(bundled_model)

    return list(by_id.values())


def sync_workflows(local: list[dict], bundled: list[dict]) -> list[dict]:
    by_id = {workflow["id"]: workflow for workflow in local if workflow.get("id")}
    for bundled_workflow in bundled:
        workflow_id = bundled_workflow.get("id")
        if not workflow_id:
            continue
        if by_id.get(workflow_id, {}).get("kind") == "custom":
            continue
        by_id[workflow_id] = bundled_workflow
    return list(by_id.values())


def upsert_custom_workflow(context: EngineContext, workflow: dict) -> dict:
    if not workflow.get("displayName") or not workflow.get("steps"):
        raise TrackExtractError("Workflow name and at least one step are required")
    workflow = {**workflow, "kind": "custom"}
    workflows = load_workflows(context)
    workflows = [candidate for candidate in workflows if candidate.get("id") != workflow.get("id")]
    workflows.append(workflow)
    save_workflows(context, workflows)
    return workflow


def preserve_local_install_fields(model: dict) -> dict:
    preserved: dict[str, Any] = {}
    for key in ["installed", "path", "downloadUrl", "downloadSizeMb", "installMethod", "runtime"]:
        if key in model:
            preserved[key] = model[key]
    return preserved


def migrate_model(model: dict) -> dict:
    model = dict(model)
    runtime = dict(model.get("runtime") or {})
    path = str(model.get("path") or "")
    backend = model.get("backend")
    extension = Path(path).suffix.lower()

    if backend == "pytorch-worker":
        model["backend"] = "python-engine"
        runtime.setdefault("provider", "demucs")
        if runtime.get("demucsModel") and not runtime.get("modelFilename"):
            runtime["modelFilename"] = runtime["demucsModel"]
        model.setdefault("installMethod", "source-only")
    elif path.startswith("models/") and extension in {".onnx", ".pth", ".ckpt"}:
        model["backend"] = "python-engine"
        model.setdefault("installMethod", "direct-url")
        runtime.setdefault("provider", "audio-separator")
        runtime.setdefault("modelFilename", Path(path).name)
    elif path.startswith("models/") and extension == ".th":
        model.setdefault("installMethod", "direct-url")
        runtime.setdefault("provider", "")
    elif not path and (model.get("sourceUrl") or model.get("downloadUrl")):
        model.setdefault("installMethod", "source-only")

    if model.get("backend") == "python-engine":
        model.setdefault("installMethod", "source-only")
        runtime.setdefault("provider", "stub" if model.get("id", "").startswith("stub") else runtime.get("provider", ""))

    model["runtime"] = runtime
    model.setdefault("downloadUrl", "")
    model.setdefault("sourceUrl", "")
    model.setdefault("license", "")
    model.setdefault("notes", "")
    model.setdefault("options", [])
    return model


def refresh_installed_status(context: EngineContext, models: list[dict]) -> None:
    for model in models:
        path = str(model.get("path") or "")
        if path.startswith("models/"):
            model["installed"] = (context.app_data_dir / path).is_file()


def local_model_path(context: EngineContext, model: dict) -> Path | None:
    path = str(model.get("path") or "")
    if path.startswith("models/"):
        candidate = context.app_data_dir / path
        return candidate if candidate.is_file() else None
    candidate = Path(path)
    if candidate.is_absolute() and candidate.is_file():
        return candidate
    repo_candidate = context.repo_root / path
    if path and repo_candidate.is_file():
        return repo_candidate
    return None
