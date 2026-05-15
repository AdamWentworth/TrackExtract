from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import Any

from .engine import Engine
from .errors import TrackExtractError
from .paths import EngineContext

LONG_COMMANDS = {"start_job", "install_model"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Track Extract Python engine")
    parser.add_argument("command")
    parser.add_argument("--jsonl", action="store_true")
    args = parser.parse_args()

    try:
        payload = json.load(sys.stdin)
        context = EngineContext.from_payload(payload)
        engine = Engine(context)
        command_args = payload.get("args") or {}
        if args.jsonl or args.command in LONG_COMMANDS:
            result = dispatch_long(engine, args.command, command_args)
            emit_result(result)
        else:
            result = dispatch_sync(engine, args.command, command_args)
            print(json.dumps(result), flush=True)
        return 0
    except Exception as error:
        if args.jsonl or args.command in LONG_COMMANDS:
            emit_error(error)
        else:
            print(error_message(error), file=sys.stderr, flush=True)
        return 1


def dispatch_sync(engine: Engine, command: str, args: dict) -> Any:
    commands = {
        "bootstrap_app": engine.bootstrap_app,
        "list_models": engine.list_models,
        "list_workflows": engine.list_workflows,
        "save_custom_workflow": engine.save_custom_workflow,
        "import_audio_files": engine.import_audio_files,
        "enqueue_separation": engine.enqueue_separation,
        "cancel_job": engine.cancel_job,
        "get_project": engine.get_project,
        "get_jobs": engine.get_jobs,
        "clear_jobs": engine.clear_jobs,
        "export_stems": engine.export_stems,
        "clear_project_stems": engine.clear_project_stems,
        "delete_project_stem": engine.delete_project_stem,
        "clear_project_source": engine.clear_project_source,
        "sync_audio_separator_catalog": engine.sync_audio_separator_catalog,
    }
    if command not in commands:
        raise TrackExtractError(f"Unknown engine command: {command}")
    return commands[command](args)


def dispatch_long(engine: Engine, command: str, args: dict) -> Any:
    def emit(name: str, payload: Any) -> None:
        print(json.dumps({"type": "event", "name": name, "payload": payload}), flush=True)

    if command == "start_job":
        return engine.start_job(args, emit)
    if command == "install_model":
        return engine.install_model(args, emit)
    raise TrackExtractError(f"Unknown long-running engine command: {command}")


def emit_result(payload: Any) -> None:
    print(json.dumps({"type": "result", "payload": payload}), flush=True)


def emit_error(error: Exception) -> None:
    print(
        json.dumps(
            {
                "type": "error",
                "message": error_message(error),
                "debug": traceback.format_exc(),
            }
        ),
        flush=True,
    )


def error_message(error: Exception) -> str:
    if isinstance(error, TrackExtractError):
        return str(error)
    return str(error) or error.__class__.__name__
