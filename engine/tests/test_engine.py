from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import types
import wave
from io import StringIO
from pathlib import Path

from trackextract_engine import installer
from trackextract_engine import project as project_module
from trackextract_engine.catalog_audio_separator import entry_from_supported_model
from trackextract_engine.engine import Engine
from trackextract_engine.jobs import claim_job, set_progress
from trackextract_engine.paths import EngineContext, default_app_data_dir
from trackextract_engine.project import clear_project_child_directory
from trackextract_engine.providers import audio_separator, demucs, worker_common
from trackextract_engine.providers.worker_common import run_worker
from trackextract_engine.registry import load_models
from trackextract_engine.state import save_jobs
from trackextract_engine.workers import audio_separator_worker, demucs_worker


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
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("APPDATA", str(tmp_path / "roaming-app-data"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-data"))

    if os.name == "nt":
        expected = tmp_path / "roaming-app-data" / "com.trackextract.desktop"
    elif sys.platform == "darwin":
        expected = tmp_path / "home" / "Library" / "Application Support" / "com.trackextract.desktop"
    else:
        expected = tmp_path / "xdg-data" / "com.trackextract.desktop"

    assert default_app_data_dir() == expected


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


def test_project_import_reuses_existing_project_for_same_source(tmp_path: Path) -> None:
    engine = Engine(context(tmp_path))
    source = tmp_path / "input.wav"
    write_wav(source)

    first = engine.import_audio_files({"paths": [str(source)]})
    second = engine.import_audio_files({"paths": [str(source)]})

    assert second["id"] == first["id"]
    assert second["rootPath"] == first["rootPath"]
    assert [path.name for path in (tmp_path / "projects").iterdir()] == ["input"]


def test_get_current_project_refreshes_missing_audio_metadata(tmp_path: Path) -> None:
    engine = Engine(context(tmp_path))
    source = tmp_path / "input.wav"
    write_wav(source)
    imported = engine.import_audio_files({"paths": [str(source)]})

    session_path = Path(imported["rootPath"]) / "session.json"
    imported["originalFiles"][0]["sampleRate"] = None
    imported["originalFiles"][0]["channels"] = None
    imported["originalFiles"][0]["durationSeconds"] = None
    session_path.write_text(json.dumps(imported), encoding="utf-8")

    refreshed = engine.get_project({})

    assert refreshed["originalFiles"][0]["sampleRate"] == 44100
    assert refreshed["originalFiles"][0]["channels"] == 1
    assert refreshed["originalFiles"][0]["durationSeconds"] is not None


def test_audio_metadata_uses_ffprobe_for_non_wav(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "input.flac"
    source.write_bytes(b"not really flac, ffprobe is mocked")

    monkeypatch.setattr(
        project_module.shutil,
        "which",
        lambda name: f"/usr/bin/{name}" if name == "ffprobe" else None,
    )

    def fake_run(*_args, **_kwargs):
        return types.SimpleNamespace(
            stdout=json.dumps(
                {
                    "streams": [{"sample_rate": "48000", "channels": 2, "duration": "12.5"}],
                    "format": {"duration": "12.5"},
                }
            )
        )

    monkeypatch.setattr(project_module.subprocess, "run", fake_run)

    metadata = project_module.read_audio_metadata(source)

    assert metadata == {"sampleRate": 48000, "channels": 2, "durationSeconds": 12.5}


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


def test_delete_project_stem_removes_only_selected_stem(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    source = tmp_path / "input.wav"
    write_wav(source)
    engine.import_audio_files({"paths": [str(source)]})

    models = load_models(ctx)
    stub = installed_stub_model(models[0])
    ctx.models_path.write_text(json.dumps([stub]), encoding="utf-8")
    job = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
    )
    completed = engine.start_job({"jobId": job["id"]}, lambda *_: None)
    vocal = next(stem for stem in completed["stems"] if stem["label"] == "Vocals")
    instrumental = next(stem for stem in completed["stems"] if stem["label"] == "Instrumental")

    updated = engine.delete_project_stem({"stemId": vocal["id"]})

    assert [stem["label"] for stem in updated["stems"]] == ["Instrumental"]
    assert not Path(vocal["path"]).exists()
    assert Path(instrumental["path"]).exists()
    refreshed_job = next(candidate for candidate in engine.get_jobs({}) if candidate["id"] == job["id"])
    assert [stem["id"] for stem in refreshed_job["stems"]] == [instrumental["id"]]


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


def test_export_selected_stems_transcodes_requested_format(monkeypatch, tmp_path: Path) -> None:
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
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        Path(command[-1]).write_bytes(b"flac")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(project_module, "find_ffmpeg", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(project_module.subprocess, "run", fake_run)

    exported = engine.export_stems({"stemIds": [vocal["id"]], "destinationPath": str(destination), "format": "flac"})

    assert exported == [str(destination / "input - Vocals.flac")]
    assert Path(exported[0]).read_bytes() == b"flac"
    assert commands[0][0] == "/usr/bin/ffmpeg"
    assert "-c:a" in commands[0]
    assert "flac" in commands[0]


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


def test_concurrent_enqueue_only_allows_one_active_job(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    source = tmp_path / "input.wav"
    write_wav(source)
    engine.import_audio_files({"paths": [str(source)]})
    ctx.models_path.write_text(json.dumps([installed_stub_model()]), encoding="utf-8")
    barrier = threading.Barrier(3)
    results = []

    def enqueue_once() -> None:
        barrier.wait()
        try:
            results.append(
                engine.enqueue_separation(
                    {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
                )
            )
        except Exception as error:
            results.append(error)

    threads = [threading.Thread(target=enqueue_once) for _ in range(2)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join()

    assert sum(isinstance(result, dict) for result in results) == 1
    assert sum(isinstance(result, Exception) for result in results) == 1
    assert len(engine.get_jobs({})) == 1


def test_cancelled_job_rejects_late_progress_and_project_switch(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    first_source = tmp_path / "first.wav"
    second_source = tmp_path / "second.wav"
    write_wav(first_source)
    write_wav(second_source)
    engine.import_audio_files({"paths": [str(first_source)]})
    ctx.models_path.write_text(json.dumps([installed_stub_model()]), encoding="utf-8")
    job = engine.enqueue_separation(
        {"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}}
    )

    try:
        engine.import_audio_files({"paths": [str(second_source)]})
    except Exception as error:
        assert "active" in str(error)
    else:
        raise AssertionError("project switching should be blocked while a job is queued")

    claim_job(ctx, job["id"])
    engine.cancel_job({"jobId": job["id"]})
    try:
        set_progress(ctx, job["id"], 0.8, "Late worker update")
    except Exception as error:
        assert "cancelled" in str(error)
    else:
        raise AssertionError("cancelled jobs must reject late progress")

    persisted = next(candidate for candidate in engine.get_jobs({}) if candidate["id"] == job["id"])
    assert persisted["state"] == "cancelled"


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


def test_worker_common_terminates_child_when_progress_callback_fails(monkeypatch, tmp_path: Path) -> None:
    terminated = []
    real_terminate = worker_common.terminate_worker

    def recording_terminate(process) -> None:
        terminated.append(process.pid)
        real_terminate(process)

    monkeypatch.setattr(worker_common, "terminate_worker", recording_terminate)
    started = time.monotonic()
    try:
        run_worker(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            tmp_path / "unused.json",
            tmp_path / "unused.log",
            "Test Worker",
            "job-1",
            emit=lambda *_: (_ for _ in ()).throw(RuntimeError("stop polling")),
            poll_interval=0.01,
        )
    except RuntimeError as error:
        assert "stop polling" in str(error)
    else:
        raise AssertionError("progress callback failure should escape")

    assert terminated
    assert time.monotonic() - started < 3


def test_demucs_provider_builds_bounded_worker_command(monkeypatch, tmp_path: Path) -> None:
    captured = {}

    def fake_run_worker(command, result_path, log_path, provider_name, job_id, emit=None):
        captured.update(
            command=command,
            result_path=result_path,
            log_path=log_path,
            provider_name=provider_name,
            job_id=job_id,
        )
        return [], log_path

    monkeypatch.setattr(demucs, "run_worker", fake_run_worker)
    project_root = tmp_path / "project"
    request = {
        "job": {
            "id": "job-1",
            "sourcePath": str(tmp_path / "source.wav"),
            "task": "vocals_instrumental",
            "options": {"device": "cpu", "demucsShifts": 2, "demucsOverlap": 0.4, "demucsSegmentSeconds": 8},
        },
        "model": {"runtime": {"demucsModel": "htdemucs", "demucsMode": "vocals"}},
        "project": {"rootPath": str(project_root), "name": "Demo"},
    }

    demucs.run(request, lambda *_: None)

    assert captured["provider_name"] == "Demucs"
    assert captured["job_id"] == "job-1"
    assert captured["command"][captured["command"].index("--device") + 1] == "cpu"
    assert captured["command"][captured["command"].index("--segment") + 1] == "8.0"


def test_demucs_worker_ignores_incompatible_hybrid_segment() -> None:
    class HTDemucs:
        segment = 7.8

    log = StringIO()

    assert demucs_worker.compatible_segment(types.SimpleNamespace(models=[HTDemucs()]), 8.0, log) is None
    assert "requires 7.8s" in log.getvalue()
    assert demucs_worker.compatible_segment(types.SimpleNamespace(models=[HTDemucs()]), 7.8, log) == 7.8


def test_demucs_worker_preserves_segment_for_non_hybrid_model() -> None:
    model = types.SimpleNamespace(segment=10.0)

    assert demucs_worker.compatible_segment(model, 6.0, StringIO()) == 6.0


def test_audio_separator_provider_builds_worker_command(monkeypatch, tmp_path: Path) -> None:
    ctx = context(tmp_path)
    model_path = ctx.app_data_dir / "models" / "audio-separator" / "model.onnx"
    model_path.parent.mkdir(parents=True)
    model_path.write_bytes(b"model")
    captured = {}

    def fake_run_worker(command, result_path, log_path, provider_name, job_id, emit=None):
        captured.update(command=command, provider_name=provider_name, job_id=job_id)
        return [], log_path

    monkeypatch.setattr(audio_separator, "run_worker", fake_run_worker)
    request = {
        "engineContext": ctx,
        "job": {
            "id": "job-2",
            "sourcePath": str(tmp_path / "source.wav"),
            "task": "vocals_instrumental",
            "options": {"batchSize": 2, "enableDenoisePass": True},
        },
        "model": {
            "displayName": "Model",
            "path": "models/audio-separator/model.onnx",
            "stems": ["Vocals", "Instrumental"],
            "sampleRate": 44100,
            "runtime": {"provider": "audio-separator"},
        },
        "project": {"rootPath": str(tmp_path / "project"), "name": "Demo"},
    }

    audio_separator.run(request, lambda *_: None)

    assert captured["provider_name"] == "Audio Separator"
    assert captured["command"][captured["command"].index("--model-filename") + 1] == "model.onnx"
    assert captured["command"][captured["command"].index("--batch-size") + 1] == "2"
    assert "--enable-denoise-pass" in captured["command"]


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


def test_installer_handles_direct_url_download(monkeypatch, tmp_path: Path) -> None:
    ctx = context(tmp_path)
    engine = Engine(ctx)
    engine.bootstrap_app({})

    class FakeResponse:
        headers = {"Content-Length": "5"}

        def __init__(self):
            self.remaining = b"model"

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def geturl(self):
            return "https://release-assets.githubusercontent.com/model.onnx"

        def read(self, _size):
            chunk, self.remaining = self.remaining, b""
            return chunk

    monkeypatch.setattr(installer.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse())
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
        "downloadUrl": "https://github.com/example/models/releases/download/v1/model.onnx",
        "sourceUrl": "",
        "license": "",
        "notes": "",
        "downloadSizeMb": 1,
        "sha256": hashlib.sha256(b"model").hexdigest(),
        "installMethod": "direct-url",
        "runtime": {"provider": "audio-separator", "modelFilename": "direct_model.onnx"},
        "options": [],
    }
    ctx.models_path.write_text(json.dumps([model]), encoding="utf-8")
    events = []
    installed = engine.install_model({"modelId": "direct_model"}, lambda name, payload: events.append((name, payload)))

    assert installed["installed"] is True
    assert (ctx.app_data_dir / "models/audio-separator/direct_model.onnx").read_bytes() == b"model"
    assert any(name == "model_download_progress" for name, _ in events)


def test_installer_rejects_untrusted_downloads_and_destinations(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    unsafe = {
        "displayName": "Unsafe Model",
        "downloadUrl": "http://127.0.0.1/model.onnx",
        "path": "../outside.onnx",
        "downloadSizeMb": 1,
    }
    try:
        installer.download_direct_model(ctx, unsafe, lambda *_: None)
    except Exception as error:
        assert "approved HTTPS" in str(error)
    else:
        raise AssertionError("untrusted model URL should be rejected")


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
