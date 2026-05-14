from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import types
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path

from trackextract_engine import installer
from trackextract_engine.catalog_audio_separator import entry_from_supported_model
from trackextract_engine.engine import Engine
from trackextract_engine.paths import EngineContext, default_app_data_dir
from trackextract_engine.project import clear_project_child_directory
from trackextract_engine.providers.worker_common import run_worker
from trackextract_engine.registry import load_models
from trackextract_engine.state import save_jobs
from trackextract_engine.workers import audio_separator_worker


def context(tmp_path: Path) -> EngineContext:
    bundled_models = Path("resources/models.json").read_text(encoding="utf-8")
    bundled_workflows = Path("resources/workflows.json").read_text(encoding="utf-8")
    return EngineContext(
        app_data_dir=tmp_path / "app-data",
        project_root=tmp_path / "projects",
        repo_root=Path.cwd(),
        bundled_models=bundled_models,
        bundled_workflows=bundled_workflows,
    )


def write_wav(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(44100)
        wav.writeframes(b"\x00\x00" * 2048)


def installed_stub_model(base: dict | None = None, **overrides) -> dict:
    model = {
        **(base or {}),
        "id": "test_stub",
        "displayName": "Test Stub",
        "backend": "python-engine",
        "tasks": ["vocals_instrumental"],
        "stems": ["Vocals", "Instrumental"],
        "sampleRate": 44100,
        "quality": "test",
        "version": "1",
        "installed": True,
        "path": "",
        "downloadUrl": "",
        "sourceUrl": "",
        "license": "",
        "notes": "",
        "installMethod": "source-only",
        "runtime": {"provider": "stub"},
        "options": [],
    }
    model.update(overrides)
    return model


def test_bootstrap_copies_registries_and_writes_state(tmp_path: Path) -> None:
    engine = Engine(context(tmp_path))
    snapshot = engine.bootstrap_app({})

    assert Path(snapshot["modelRegistryPath"]).is_file()
    assert Path(snapshot["workflowRegistryPath"]).is_file()
    assert snapshot["models"]
    assert snapshot["workflows"]
    assert (tmp_path / "app-data").is_dir()


def test_default_app_data_dir_matches_desktop_identifier(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-data"))

    assert default_app_data_dir() == tmp_path / "xdg-data" / "com.trackextract.app"


def test_registry_migration_accepts_current_models(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    models = load_models(ctx)

    demucs = next(model for model in models if model["id"] == "demucs_htdemucs_vocals_instrumental")
    assert demucs["backend"] == "python-engine"
    assert demucs["runtime"]["provider"] == "demucs"

    uvr = next(model for model in models if model["id"] == "uvr_mdx23c_instvoc_hq")
    assert uvr["backend"] == "python-engine"
    assert uvr["runtime"]["provider"] == "audio-separator"


def test_bootstrap_sync_removes_deprecated_models_and_preserves_custom_workflows(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    ctx.app_data_dir.mkdir(parents=True)
    ctx.models_path.write_text(
        json.dumps(
            [
                {
                    "id": "stub_vocals_instrumental",
                    "displayName": "Deprecated Stub",
                    "backend": "stub",
                    "tasks": ["vocals_instrumental"],
                    "stems": ["Vocals", "Instrumental"],
                    "sampleRate": 44100,
                    "quality": "development",
                    "version": "0",
                    "installed": True,
                    "path": "",
                }
            ]
        ),
        encoding="utf-8",
    )
    custom_workflow = {
        "id": "custom_keep",
        "displayName": "Keep Me",
        "description": "User workflow",
        "kind": "custom",
        "task": "vocals_instrumental",
        "steps": [
            {
                "id": "step_1",
                "displayName": "Split",
                "task": "vocals_instrumental",
                "modelId": "demucs_htdemucs_vocals_instrumental",
                "options": {},
            }
        ],
    }
    ctx.workflows_path.write_text(json.dumps([custom_workflow]), encoding="utf-8")

    snapshot = Engine(ctx).bootstrap_app({})

    assert all(model["id"] != "stub_vocals_instrumental" for model in snapshot["models"])
    assert any(workflow["id"] == "custom_keep" for workflow in snapshot["workflows"])


def test_project_import_creates_folder_tree_and_session(tmp_path: Path) -> None:
    engine = Engine(context(tmp_path))
    source = tmp_path / "input.wav"
    write_wav(source)

    session = engine.import_audio_files({"paths": [str(source)]})

    root = Path(session["rootPath"])
    assert (root / "original").is_dir()
    assert (root / "stems").is_dir()
    assert (root / "renders").is_dir()
    assert (root / "logs").is_dir()
    assert (root / "session.json").is_file()
    assert session["originalFiles"][0]["sampleRate"] == 44100


def test_job_lifecycle_and_stub_provider_writes_valid_wav(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    source = tmp_path / "input.wav"
    write_wav(source)
    engine.import_audio_files({"paths": [str(source)]})

    models = load_models(ctx)
    stub = installed_stub_model(models[0])
    (ctx.models_path).write_text(json.dumps([stub]), encoding="utf-8")

    job = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
    )
    events = []
    completed = engine.start_job({"jobId": job["id"]}, lambda name, payload: events.append((name, payload)))

    assert completed["state"] == "complete"
    assert any(name == "job_progress" for name, _ in events)
    for stem in completed["stems"]:
        with wave.open(stem["path"], "rb") as wav:
            assert wav.getframerate() == 44100


def test_stub_workflow_step_can_use_previous_stem_as_source(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    source = tmp_path / "input.wav"
    write_wav(source)
    engine.import_audio_files({"paths": [str(source)]})

    models = load_models(ctx)
    first_stub = installed_stub_model(
        models[0],
        id="test_extract_stub",
        displayName="Test Extract Stub",
        tasks=["vocal_cleanup_chain"],
    )
    second_stub = installed_stub_model(
        models[0],
        id="test_clean_stub",
        displayName="Test Clean Stub",
        tasks=["vocal_denoise"],
        stems=["Clean Vocal", "Noise"],
    )
    ctx.models_path.write_text(json.dumps([first_stub, second_stub]), encoding="utf-8")

    first_job = engine.enqueue_separation(
        {"task": "vocal_cleanup_chain", "modelId": "test_extract_stub", "sourceId": None, "options": {}}
    )
    first_completed = engine.start_job({"jobId": first_job["id"]}, lambda *_: None)
    vocal_stem = next(stem for stem in first_completed["stems"] if stem["label"] == "Vocals")

    second_job = engine.enqueue_separation(
        {
            "task": "vocal_denoise",
            "modelId": "test_clean_stub",
            "sourceId": vocal_stem["id"],
            "options": {},
        }
    )
    second_completed = engine.start_job({"jobId": second_job["id"]}, lambda *_: None)

    assert second_job["sourceId"] == vocal_stem["id"]
    assert second_job["sourcePath"] == vocal_stem["path"]
    assert second_completed["state"] == "complete"
    assert [stem["label"] for stem in second_completed["stems"]] == ["Clean Vocal", "Noise"]


def test_workspace_cleanup_clears_stems_and_source(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    source = tmp_path / "input.wav"
    write_wav(source)
    imported = engine.import_audio_files({"paths": [str(source)]})

    models = load_models(ctx)
    stub = installed_stub_model(models[0])
    ctx.models_path.write_text(json.dumps([stub]), encoding="utf-8")
    job = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
    )
    completed = engine.start_job({"jobId": job["id"]}, lambda *_: None)
    stem_paths = [Path(stem["path"]) for stem in completed["stems"]]

    assert engine.clear_jobs({}) == []
    assert engine.get_jobs({}) == []
    assert engine.get_project({})["jobs"] == []
    assert all(path.exists() for path in stem_paths)

    cleared_stems = engine.clear_project_stems({})

    assert cleared_stems["originalFiles"] == imported["originalFiles"]
    assert cleared_stems["stems"] == []
    assert all(not path.exists() for path in stem_paths)
    assert engine.get_jobs({}) == []

    cleared_source = engine.clear_project_source({})

    assert cleared_source["originalFiles"] == []
    assert cleared_source["jobs"] == []
    assert cleared_source["stems"] == []
    assert engine.get_jobs({}) == []
    assert not Path(imported["originalFiles"][0]["projectPath"]).exists()


def test_export_selected_stems_copies_only_requested_files(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    source = tmp_path / "input.wav"
    write_wav(source)
    engine.import_audio_files({"paths": [str(source)]})

    models = load_models(ctx)
    ctx.models_path.write_text(json.dumps([installed_stub_model(models[0])]), encoding="utf-8")
    job = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
    )
    completed = engine.start_job({"jobId": job["id"]}, lambda *_: None)
    vocal = next(stem for stem in completed["stems"] if stem["label"] == "Vocals")
    destination = tmp_path / "export"

    exported = engine.export_stems({"stemIds": [vocal["id"]], "destinationPath": str(destination)})

    assert exported == [str(destination / Path(vocal["path"]).name)]
    assert (destination / Path(vocal["path"]).name).is_file()
    assert len(list(destination.iterdir())) == 1


def test_cleanup_refuses_to_clear_paths_outside_project(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    outside = tmp_path / "outside"
    project_root.mkdir()
    outside.mkdir()
    protected = outside / "keep.txt"
    protected.write_text("do not delete", encoding="utf-8")

    try:
        clear_project_child_directory(project_root, "../outside")
    except Exception as error:
        assert "outside this project" in str(error)
    else:
        raise AssertionError("cleanup should reject paths outside the project root")

    assert protected.read_text(encoding="utf-8") == "do not delete"


def test_enqueue_rejects_active_job(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    source = tmp_path / "input.wav"
    write_wav(source)
    engine.import_audio_files({"paths": [str(source)]})

    models = load_models(ctx)
    stub = installed_stub_model(models[0])
    ctx.models_path.write_text(json.dumps([stub]), encoding="utf-8")
    active = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
    )
    save_jobs(ctx, [{**active, "state": "running"}])

    try:
        engine.enqueue_separation(
            {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
        )
    except Exception as error:
        assert "already running" in str(error)
    else:
        raise AssertionError("enqueue should reject a second active job")


def test_cancel_and_failed_job_transitions(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    source = tmp_path / "input.wav"
    write_wav(source)
    engine.import_audio_files({"paths": [str(source)]})

    models = load_models(ctx)
    broken = installed_stub_model(
        models[0],
        id="broken_model",
        displayName="Broken Model",
        runtime={"provider": "missing-provider"},
    )
    ctx.models_path.write_text(json.dumps([broken]), encoding="utf-8")

    cancellable = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "broken_model", "sourceId": None, "options": {}}
    )
    cancelled = engine.cancel_job({"jobId": cancellable["id"]})
    assert cancelled["state"] == "cancelled"
    assert cancelled["statusMessage"] == "Cancelled"

    failing = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "broken_model", "sourceId": None, "options": {}}
    )
    try:
        engine.start_job({"jobId": failing["id"]}, lambda *_: None)
    except Exception as error:
        assert "not runnable" in str(error)
    else:
        raise AssertionError("start_job should fail unsupported providers")

    failed = next(job for job in engine.get_jobs({}) if job["id"] == failing["id"])
    assert failed["state"] == "failed"
    assert "not runnable" in failed["error"]


def test_audio_separator_catalog_mapping() -> None:
    entry = entry_from_supported_model(
        "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        {"Name": "BS RoFormer Vocals", "Type": "RoFormer", "Stems": ["Vocals", "Instrumental"]},
    )

    assert entry["backend"] == "python-engine"
    assert entry["installMethod"] == "audio-separator"
    assert entry["runtime"]["provider"] == "audio-separator"
    assert "vocals_instrumental" in entry["tasks"]


def test_audio_separator_worker_normalizes_outputs_and_infers_aliases(tmp_path: Path) -> None:
    output_dir = tmp_path / "stems"
    output_dir.mkdir()
    instrumental = output_dir / "Demo Song_(No Vocals).wav"
    vocals = output_dir / "Demo Song_(Vocals).wav"
    instrumental.write_bytes(b"instrumental")
    vocals.write_bytes(b"vocals")
    log = StringIO()

    stems = audio_separator_worker.normalize_outputs(
        "Demo Song",
        output_dir,
        ["Vocals", "Instrumental"],
        [instrumental, vocals],
        log,
    )

    assert [stem["label"] for stem in stems] == ["Vocals", "Instrumental"]
    assert [Path(stem["path"]).name for stem in stems] == ["Demo Song - Vocals.wav", "Demo Song - Instrumental.wav"]
    assert not instrumental.exists()
    assert not vocals.exists()
    assert "Normalized Demo Song_(No Vocals).wav to Demo Song - Instrumental.wav" in log.getvalue()


def test_worker_common_emits_heartbeat_progress(tmp_path: Path) -> None:
    log_path = tmp_path / "worker.log"
    result_path = tmp_path / "result.json"
    command = [
        sys.executable,
        "-c",
        (
            "import json, pathlib, sys, time; "
            "log = pathlib.Path(sys.argv[1]); result = pathlib.Path(sys.argv[2]); "
            "log.write_text('Running test worker\\n', encoding='utf-8'); "
            "time.sleep(0.15); "
            "result.write_text(json.dumps({'stems': []}), encoding='utf-8')"
        ),
        str(log_path),
        str(result_path),
    ]
    events = []

    stems, returned_log_path = run_worker(
        command,
        result_path,
        log_path,
        "Test Worker",
        "job-1",
        emit=lambda progress, message: events.append((progress, message)),
        poll_interval=0.05,
    )

    assert stems == []
    assert returned_log_path == log_path
    assert any("Running test worker" in message for _, message in events)


def test_audio_separator_worker_uses_static_ffmpeg_when_system_ffmpeg_is_missing(monkeypatch) -> None:
    ready = {"value": False}

    def fake_which(name: str) -> str | None:
        return f"/static/{name}" if ready["value"] and name in {"ffmpeg", "ffprobe"} else None

    def fake_add_paths(weak: bool = True) -> None:
        assert weak is True
        ready["value"] = True

    monkeypatch.setattr(audio_separator_worker.shutil, "which", fake_which)
    monkeypatch.setitem(sys.modules, "static_ffmpeg", types.SimpleNamespace(add_paths=fake_add_paths))
    log = StringIO()

    audio_separator_worker.ensure_ffmpeg_on_path(log)

    assert "Using static-ffmpeg ffmpeg/ffprobe" in log.getvalue()


def test_installer_rejects_source_only(tmp_path: Path) -> None:
    engine = Engine(context(tmp_path))
    engine.bootstrap_app({})
    mvsep = next(model for model in load_models(context(tmp_path)) if model["sourceUrl"] == "https://mvsep.com/en")

    try:
        engine.install_model({"modelId": mvsep["id"]}, lambda *_: None)
    except Exception as error:
        assert "source reference" in str(error)
    else:
        raise AssertionError("source-only install should fail")


def test_installer_handles_direct_url_download(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    engine.bootstrap_app({})
    serve_dir = tmp_path / "serve"
    serve_dir.mkdir()
    model_file = serve_dir / "model.onnx"
    model_file.write_bytes(b"model")

    previous_cwd = Path.cwd()
    os.chdir(serve_dir)
    server = ThreadingHTTPServer(("127.0.0.1", 0), SimpleHTTPRequestHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        model = {
            "id": "direct_model",
            "displayName": "Direct Model",
            "backend": "python-engine",
            "tasks": ["vocals_instrumental"],
            "stems": ["Vocals", "Instrumental"],
            "sampleRate": 44100,
            "quality": "test",
            "version": "1",
            "installed": False,
            "path": "models/audio-separator/direct_model.onnx",
            "downloadUrl": f"http://127.0.0.1:{server.server_port}/model.onnx",
            "sourceUrl": "",
            "license": "",
            "notes": "",
            "downloadSizeMb": 1,
            "installMethod": "direct-url",
            "runtime": {"provider": "audio-separator", "modelFilename": "direct_model.onnx"},
            "options": [],
        }
        ctx.models_path.write_text(json.dumps([model]), encoding="utf-8")
        events = []
        installed = engine.install_model(
            {"modelId": "direct_model"}, lambda name, payload: events.append((name, payload))
        )
    finally:
        server.shutdown()
        os.chdir(previous_cwd)

    assert installed["installed"] is True
    assert (ctx.app_data_dir / "models/audio-separator/direct_model.onnx").read_bytes() == b"model"
    assert any(name == "model_download_progress" for name, _ in events)


def test_installer_prefetches_audio_separator_models(monkeypatch, tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    engine.bootstrap_app({})
    model = {
        "id": "prefetch_model",
        "displayName": "Prefetch Model",
        "backend": "python-engine",
        "tasks": ["vocals_instrumental"],
        "stems": ["Vocals", "Instrumental"],
        "sampleRate": 44100,
        "quality": "test",
        "version": "1",
        "installed": False,
        "path": "",
        "downloadUrl": "",
        "sourceUrl": "",
        "license": "",
        "notes": "",
        "installMethod": "audio-separator",
        "runtime": {"provider": "audio-separator", "modelFilename": "prefetch.ckpt"},
        "options": [],
    }
    ctx.models_path.write_text(json.dumps([model]), encoding="utf-8")
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return types.SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(installer.subprocess, "run", fake_run)
    events = []

    installed = engine.install_model(
        {"modelId": "prefetch_model"}, lambda name, payload: events.append((name, payload))
    )

    assert installed["installed"] is True
    assert installed["path"] == "models/audio-separator/prefetch.ckpt"
    assert calls
    assert "--download_model_only" in calls[0][0]
    assert "--model_filename" in calls[0][0]
    assert any(
        payload["message"] == "Installed Prefetch Model"
        for name, payload in events
        if name == "model_download_progress"
    )


def test_jsonl_start_job_protocol(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    source = tmp_path / "input.wav"
    write_wav(source)
    engine = Engine(ctx)
    engine.import_audio_files({"paths": [str(source)]})
    models = load_models(ctx)
    stub = {
        **models[0],
        "id": "test_stub",
        "displayName": "Test Stub",
        "backend": "python-engine",
        "tasks": ["vocals_instrumental"],
        "stems": ["Vocals", "Instrumental"],
        "installed": True,
        "path": "",
        "runtime": {"provider": "stub"},
        "options": [],
    }
    ctx.models_path.write_text(json.dumps([stub]), encoding="utf-8")
    job = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
    )
    payload = {
        "context": {
            "appDataDir": str(ctx.app_data_dir),
            "projectRoot": str(ctx.project_root),
            "repoRoot": str(ctx.repo_root),
            "bundledModels": ctx.bundled_models,
            "bundledWorkflows": ctx.bundled_workflows,
        },
        "args": {"jobId": job["id"]},
    }

    completed = subprocess.run(
        [sys.executable, "-m", "trackextract_engine", "start_job", "--jsonl"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
        env=os.environ,
    )

    assert completed.returncode == 0, completed.stderr
    envelopes = [json.loads(line) for line in completed.stdout.splitlines()]
    assert any(item.get("type") == "event" and item.get("name") == "job_progress" for item in envelopes)
    assert envelopes[-1]["type"] == "result"


def test_cli_reports_malformed_json_for_sync_and_jsonl_commands() -> None:
    sync = subprocess.run(
        [sys.executable, "-m", "trackextract_engine", "bootstrap_app"],
        input="{",
        capture_output=True,
        text=True,
        check=False,
        env=os.environ,
    )
    long = subprocess.run(
        [sys.executable, "-m", "trackextract_engine", "start_job", "--jsonl"],
        input="{",
        capture_output=True,
        text=True,
        check=False,
        env=os.environ,
    )

    assert sync.returncode == 1
    assert "Expecting" in sync.stderr
    assert long.returncode == 1
    envelope = json.loads(long.stdout)
    assert envelope["type"] == "error"
    assert "Expecting" in envelope["message"]
