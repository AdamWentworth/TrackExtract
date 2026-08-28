from __future__ import annotations

from pathlib import Path

from .catalog_audio_separator import sync_catalog
from .errors import CancelledError, TrackExtractError
from .installer import install_model
from .jobs import (
    cancel,
    claim_job,
    clear_job_history,
    complete,
    enqueue,
    fail,
    get_job,
    list_jobs,
    set_progress,
    set_state,
)
from .paths import EngineContext
from .project import (
    clear_project_source,
    clear_project_stems,
    delete_project_stem,
    export_stems,
    get_current_project,
    import_audio_files,
)
from .providers import run_provider
from .registry import bootstrap_registries, find_model, load_models, load_workflows, upsert_custom_workflow
from .schemas import read_json


class Engine:
    def __init__(self, context: EngineContext):
        self.context = context

    def bootstrap_app(self, _args: dict) -> dict:
        models, workflows = bootstrap_registries(self.context)
        return {
            "projectRoot": str(self.context.project_root),
            "appDataDir": str(self.context.app_data_dir),
            "modelRegistryPath": str(self.context.models_path),
            "workflowRegistryPath": str(self.context.workflows_path),
            "models": models,
            "workflows": workflows,
            "currentProject": get_current_project(self.context),
            "jobs": list_jobs(self.context),
        }

    def list_models(self, _args: dict) -> list[dict]:
        return load_models(self.context)

    def list_workflows(self, _args: dict) -> list[dict]:
        return load_workflows(self.context)

    def save_custom_workflow(self, args: dict) -> dict:
        return upsert_custom_workflow(self.context, args.get("workflow") or {})

    def import_audio_files(self, args: dict) -> dict:
        return import_audio_files(self.context, args.get("paths") or [])

    def enqueue_separation(self, args: dict) -> dict:
        return enqueue(
            self.context,
            args.get("task"),
            args.get("modelId"),
            args.get("sourceId"),
            args.get("options") or {},
        )

    def get_project(self, _args: dict) -> dict | None:
        return get_current_project(self.context)

    def get_jobs(self, _args: dict) -> list[dict]:
        return list_jobs(self.context)

    def get_snapshot(self, args: dict) -> dict:
        snapshot = {
            "currentProject": get_current_project(self.context),
            "jobs": list_jobs(self.context),
        }
        if args.get("includeRegistries"):
            snapshot["models"] = load_models(self.context)
            snapshot["workflows"] = load_workflows(self.context)
        return snapshot

    def clear_jobs(self, _args: dict) -> list[dict]:
        return clear_job_history(self.context)

    def export_stems(self, args: dict) -> list[str]:
        return export_stems(
            self.context,
            args.get("stemIds") or [],
            args.get("destinationPath"),
            args.get("format") or "wav",
        )

    def clear_project_stems(self, _args: dict) -> dict:
        return clear_project_stems(self.context)

    def delete_project_stem(self, args: dict) -> dict:
        return delete_project_stem(self.context, args.get("stemId"))

    def clear_project_source(self, _args: dict) -> dict:
        return clear_project_source(self.context)

    def cancel_job(self, args: dict) -> dict:
        return cancel(self.context, args.get("jobId"))

    def sync_audio_separator_catalog(self, _args: dict) -> list[dict]:
        return sync_catalog(self.context)

    def install_model(self, args: dict, emit) -> dict:
        return install_model(self.context, args.get("modelId"), emit)

    def start_job(self, args: dict, emit) -> dict:
        job_id = args.get("jobId")
        job = claim_job(self.context, job_id)
        emit("job_state_changed", job)

        try:
            job = set_state(self.context, job_id, "running", "Running separation")
            emit("job_state_changed", job)
            emit("job_progress", {"jobId": job_id, "progress": 0.03, "message": "Preparing Python engine"})

            project_path = Path(job.get("projectSessionPath") or "")
            project = read_json(project_path, None) if project_path.is_file() else None
            if not project:
                current_project = get_current_project(self.context)
                project = (
                    current_project if current_project and current_project.get("id") == job.get("projectId") else None
                )
            if not project:
                raise TrackExtractError("The project associated with this job is no longer available")
            model = find_model(self.context, job["modelId"])

            def provider_progress(progress: float, message: str) -> None:
                updated = set_progress(self.context, job_id, progress, message)
                emit("job_progress", {"jobId": job_id, "progress": progress, "message": message})
                emit("job_state_changed", updated)

            stems, log_path = run_provider(
                {
                    "context": {
                        "appDataDir": str(self.context.app_data_dir),
                        "projectRoot": str(self.context.project_root),
                        "repoRoot": str(self.context.repo_root),
                    },
                    "engineContext": self.context,
                    "job": job,
                    "project": project,
                    "model": model,
                },
                provider_progress,
            )
            final_job, updated_project = complete(self.context, job_id, stems, Path(log_path))
            emit("project_updated", updated_project)
            emit("job_state_changed", final_job)
            emit("job_progress", {"jobId": job_id, "progress": 1.0, "message": "Separation complete"})
            return final_job
        except CancelledError:
            cancelled = get_job(self.context, job_id)
            emit("job_state_changed", cancelled)
            return cancelled
        except Exception as error:
            failed = fail(self.context, job_id, str(error))
            emit("job_state_changed", failed)
            raise
