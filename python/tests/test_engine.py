from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import wave
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from trackextract_engine.catalog_audio_separator import entry_from_supported_model
from trackextract_engine.engine import Engine
from trackextract_engine.paths import EngineContext
from trackextract_engine.providers.stub import write_silence
from trackextract_engine.registry import load_models


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


def test_bootstrap_copies_registries_and_writes_state(tmp_path: Path) -> None:
    engine = Engine(context(tmp_path))
    snapshot = engine.bootstrap_app({})

    assert Path(snapshot["modelRegistryPath"]).is_file()
    assert Path(snapshot["workflowRegistryPath"]).is_file()
    assert snapshot["models"]
    assert snapshot["workflows"]
    assert (tmp_path / "app-data").is_dir()


def test_registry_migration_accepts_current_models(tmp_path: Path) -> None:
    ctx = context(tmp_path)
    models = load_models(ctx)

    demucs = next(model for model in models if model["id"] == "demucs_htdemucs_vocals_instrumental")
    assert demucs["backend"] == "python-engine"
    assert demucs["runtime"]["provider"] == "demucs"

    uvr = next(model for model in models if model["id"] == "uvr_mdx23c_instvoc_hq")
    assert uvr["backend"] == "python-engine"
    assert uvr["runtime"]["provider"] == "audio-separator"


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
    stub = {
        **models[0],
        "id": "test_stub",
        "displayName": "Test Stub",
        "backend": "python-engine",
        "tasks": ["vocals_instrumental"],
        "stems": ["Vocals", "Instrumental"],
        "installed": True,
        "path": "",
        "installMethod": "source-only",
        "runtime": {"provider": "stub"},
        "options": [],
    }
    (ctx.models_path).write_text(json.dumps([stub]), encoding="utf-8")

    job = engine.enqueue_separation({"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}})
    events = []
    completed = engine.start_job({"jobId": job["id"]}, lambda name, payload: events.append((name, payload)))

    assert completed["state"] == "complete"
    assert any(name == "job_progress" for name, _ in events)
    for stem in completed["stems"]:
        with wave.open(stem["path"], "rb") as wav:
            assert wav.getframerate() == 44100


def test_audio_separator_catalog_mapping() -> None:
    entry = entry_from_supported_model(
        "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        {"Name": "BS RoFormer Vocals", "Type": "RoFormer", "Stems": ["Vocals", "Instrumental"]},
    )

    assert entry["backend"] == "python-engine"
    assert entry["installMethod"] == "audio-separator"
    assert entry["runtime"]["provider"] == "audio-separator"
    assert "vocals_instrumental" in entry["tasks"]


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
        installed = engine.install_model({"modelId": "direct_model"}, lambda name, payload: events.append((name, payload)))
    finally:
        server.shutdown()
        os.chdir(previous_cwd)

    assert installed["installed"] is True
    assert (ctx.app_data_dir / "models/audio-separator/direct_model.onnx").read_bytes() == b"model"
    assert any(name == "model_download_progress" for name, _ in events)


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
    job = engine.enqueue_separation({"task": "vocals_instrumental", "modelId": "test_stub", "sourceId": None, "options": {}})
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
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        env={"PYTHONPATH": "python"},
    )

    assert completed.returncode == 0, completed.stderr
    envelopes = [json.loads(line) for line in completed.stdout.splitlines()]
    assert any(item.get("type") == "event" and item.get("name") == "job_progress" for item in envelopes)
    assert envelopes[-1]["type"] == "result"
