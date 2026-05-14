from __future__ import annotations

import json
import re
import subprocess
import sys

from .errors import TrackExtractError
from .paths import EngineContext
from .registry import load_models, save_models
from .schemas import TASK_LABELS


def sync_catalog(context: EngineContext) -> list[dict]:
    models = load_models(context)
    discovered = list_supported_models()
    by_id = {model["id"]: model for model in models}
    for filename, info in discovered.items():
        entry = entry_from_supported_model(filename, info)
        existing = by_id.get(entry["id"])
        if existing:
            entry["installed"] = existing.get("installed", False)
            entry["path"] = existing.get("path") or entry["path"]
        by_id[entry["id"]] = entry
    merged = list(by_id.values())
    save_models(context, merged)
    return merged


def list_supported_models() -> dict:
    completed = subprocess.run(
        [sys.executable, "-m", "audio_separator.utils.cli", "--list_models", "--list_format=json"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise TrackExtractError(completed.stderr.strip() or "audio-separator model listing failed")
    return json.loads(completed.stdout)


def entry_from_supported_model(filename: str, info: dict) -> dict:
    stems = normalize_stems(info.get("Stems") or info.get("stems") or ["Vocals", "Instrumental"])
    tasks = tasks_for_stems(stems)
    display = info.get("Name") or info.get("name") or filename
    arch = info.get("Type") or info.get("type") or "audio-separator"
    return {
        "id": f"audio_separator_{slugify(filename)}",
        "displayName": display,
        "backend": "python-engine",
        "tasks": tasks,
        "stems": stems,
        "sampleRate": 44100,
        "quality": quality_for_name(display, filename),
        "version": filename,
        "installed": False,
        "path": "",
        "downloadUrl": "",
        "sourceUrl": "https://github.com/nomadkaraoke/python-audio-separator",
        "license": "Model-specific",
        "notes": f"Discovered from audio-separator supported model list. Architecture: {arch}.",
        "installMethod": "audio-separator",
        "runtime": {
            "provider": "audio-separator",
            "modelFilename": filename,
            "device": "auto",
        },
        "options": default_audio_separator_options(),
    }


def normalize_stems(stems: list) -> list[str]:
    normalized = []
    for stem in stems:
        label = str(stem).strip()
        if not label:
            continue
        normalized.append(label[:1].upper() + label[1:])
    return normalized or ["Vocals", "Instrumental"]


def tasks_for_stems(stems: list[str]) -> list[str]:
    lower = {stem.lower() for stem in stems}
    tasks = []
    if "vocals" in lower or "instrumental" in lower:
        tasks.extend(["vocals_instrumental", "vocal_cleanup_chain"])
    if {"drums", "bass", "other"}.intersection(lower):
        tasks.append("full_stem_split")
    if "drums" in lower:
        tasks.append("drums_only")
    if "bass" in lower:
        tasks.append("bass_only")
    if "guitar" in lower:
        tasks.append("guitar_only")
    if "piano" in lower:
        tasks.append("piano_only")
    if "reverb" in lower or "dry vocal" in lower:
        tasks.append("vocal_dereverb")
    if "noise" in lower or "clean vocal" in lower:
        tasks.append("vocal_denoise")
    return sorted(set(tasks), key=list(TASK_LABELS).index) if tasks else ["experimental_best_quality"]


def quality_for_name(display: str, filename: str) -> str:
    value = f"{display} {filename}".lower()
    if "karaoke" in value or "denoise" in value or "reverb" in value:
        return "specialized"
    if "roformer" in value or "hq" in value:
        return "best"
    return "balanced"


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")[:80]


def default_audio_separator_options() -> list[dict]:
    return [
        {
            "id": "device",
            "displayName": "Device",
            "type": "select",
            "defaultValue": "auto",
            "choices": [
                {"value": "auto", "label": "Auto"},
                {"value": "cuda", "label": "CUDA"},
                {"value": "directml", "label": "DirectML"},
                {"value": "cpu", "label": "CPU"},
            ],
        },
        {"id": "mdxSegmentSize", "displayName": "Segment", "type": "integer", "defaultValue": 256, "min": 32, "max": 512, "step": 32},
        {"id": "mdxOverlap", "displayName": "Overlap", "type": "number", "defaultValue": 0.25, "min": 0.01, "max": 0.99, "step": 0.01},
        {"id": "batchSize", "displayName": "Batch", "type": "integer", "defaultValue": 1, "min": 1, "max": 16, "step": 1},
    ]
