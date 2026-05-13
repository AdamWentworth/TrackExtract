#!/usr/bin/env python3
"""TrackExtract audio-separator sidecar worker.

Rust owns the app state and launches this process behind the backend trait. The
worker keeps the Python dependency surface out of the Tauri UI and reports only
final stem paths through a JSON result file.
"""

from __future__ import annotations

import argparse
import inspect
import json
import logging
import os
import re
import shutil
import traceback
from pathlib import Path


COMMON_STEM_ALIASES = {
    "Vocals": ["Vocals", "Vocal", "Lead Vocal", "Lead Vocals"],
    "Instrumental": ["Instrumental", "No Vocals", "No Vocal", "No Lead Vocal"],
    "Drums": ["Drums", "Drum"],
    "No Drums": ["No Drums"],
    "Bass": ["Bass"],
    "No Bass": ["No Bass"],
    "Guitar": ["Guitar", "Guitars"],
    "No Guitar": ["No Guitar", "No Guitars"],
    "Piano": ["Piano"],
    "No Piano": ["No Piano"],
    "Other": ["Other", "No Other"],
    "Dry Vocal": ["Dry Vocal", "Dry Vocals", "No Reverb"],
    "Reverb": ["Reverb", "Echo", "Reverb Echo"],
    "Clean Vocal": ["Clean Vocal", "Clean Vocals", "Denoised Vocal", "Denoised Vocals"],
    "Noise": ["Noise", "Noisy"],
    "Backing Vocals": ["Backing Vocals", "Back Vocals", "Background Vocals"],
    "Crowd": ["Crowd", "Audience"],
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run audio-separator for TrackExtract")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-file-dir", required=True)
    parser.add_argument("--model-filename", required=True)
    parser.add_argument("--result-json", required=True)
    parser.add_argument("--log-path", required=True)
    parser.add_argument("--project-name", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--stems-json", required=True)
    parser.add_argument("--sample-rate", type=int, default=44100)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--mdx-segment-size", type=int, default=256)
    parser.add_argument("--mdx-overlap", type=float, default=0.25)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--enable-denoise-pass", action="store_true")
    args = parser.parse_args()

    log_path = Path(args.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with log_path.open("w", encoding="utf-8", buffering=1) as log:
        try:
            return run(args, log)
        except Exception:
            log.write("\nTrackExtract Audio Separator worker crashed:\n")
            traceback.print_exc(file=log)
            return 1


def run(args: argparse.Namespace, log) -> int:
    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    model_file_dir = Path(args.model_file_dir)
    result_json = Path(args.result_json)
    expected_stems = json.loads(args.stems_json)

    output_dir.mkdir(parents=True, exist_ok=True)
    model_file_dir.mkdir(parents=True, exist_ok=True)
    result_json.parent.mkdir(parents=True, exist_ok=True)

    log.write(f"TrackExtract Audio Separator worker job {args.job_id}\n")
    log.write(f"Input: {input_path}\n")
    log.write(f"Task: {args.task}\n")
    log.write(f"Model file dir: {model_file_dir}\n")
    log.write(f"Model filename: {args.model_filename}\n")
    log.write(f"Device: {args.device}\n")
    log.write(f"Sample rate: {args.sample_rate}\n")
    log.write(f"Expected stems: {', '.join(expected_stems)}\n\n")

    prepare_device(args.device, log)
    ensure_ffmpeg_on_path(log)

    output_files = separate_with_audio_separator(args, input_path, output_dir, expected_stems, log)
    stems = normalize_outputs(args.project_name, output_dir, expected_stems, output_files, log)

    result_json.write_text(json.dumps({"stems": stems}, indent=2), encoding="utf-8")
    log.write("\nComplete\n")
    return 0


def prepare_device(device: str, log) -> None:
    normalized = device.strip().lower()
    if normalized == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        log.write("Forced CPU mode by hiding CUDA devices from the worker.\n")
    elif normalized in {"cuda", "gpu"}:
        log.write("GPU mode requested. The installed audio-separator extras decide CUDA availability.\n")
    elif normalized in {"directml", "dml"}:
        log.write("DirectML requested. This requires the audio-separator dml extra on Windows.\n")
    else:
        log.write("Auto device mode requested.\n")


def separate_with_audio_separator(
    args: argparse.Namespace,
    input_path: Path,
    output_dir: Path,
    expected_stems: list[str],
    log,
) -> list[Path]:
    from audio_separator.separator import Separator

    custom_names = custom_output_names(args.project_name, expected_stems)
    separator_kwargs = supported_kwargs(
        Separator,
        {
            "log_level": logging.INFO,
            "log_formatter": logging.Formatter(
                fmt="%(asctime)s.%(msecs)03d - %(levelname)s - %(module)s - %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            ),
            "model_file_dir": str(Path(args.model_file_dir)),
            "output_dir": str(output_dir),
            "output_format": "WAV",
            "sample_rate": args.sample_rate,
            "use_soundfile": True,
            "use_directml": args.device.strip().lower() in {"directml", "dml"},
            "mdx_params": {
                "segment_size": args.mdx_segment_size,
                "overlap": args.mdx_overlap,
                "batch_size": args.batch_size,
                "enable_denoise": args.enable_denoise_pass,
            },
            "vr_params": {
                "batch_size": args.batch_size,
            },
            "mdxc_params": {
                "segment_size": args.mdx_segment_size,
                "batch_size": args.batch_size,
            },
        },
    )

    log.write("Initializing audio-separator\n")
    separator = Separator(**separator_kwargs)
    log.write(f"Loading model {args.model_filename}\n")
    separator.load_model(model_filename=args.model_filename)
    log.write(f"Running separation with output names: {json.dumps(custom_names, sort_keys=True)}\n")
    output_files = separator.separate(str(input_path), custom_output_names=custom_names)

    if isinstance(output_files, (str, Path)):
        output_files = [output_files]

    paths = []
    for output_file in output_files:
        path = Path(output_file)
        if not path.is_absolute():
            path = output_dir / path
        paths.append(path)
        log.write(f"audio-separator produced {path}\n")

    return paths


def supported_kwargs(callable_object, values: dict) -> dict:
    signature = inspect.signature(callable_object)
    return {key: value for key, value in values.items() if key in signature.parameters}


def custom_output_names(project_name: str, expected_stems: list[str]) -> dict[str, str]:
    names: dict[str, str] = {}
    for label in expected_stems:
        base_name = daw_friendly_file_stem(project_name, label)
        aliases = COMMON_STEM_ALIASES.get(label, [label])
        for alias in aliases:
            names.setdefault(alias, base_name)
    return names


def normalize_outputs(
    project_name: str,
    output_dir: Path,
    expected_stems: list[str],
    output_files: list[Path],
    log,
) -> list[dict[str, str]]:
    stems = []
    assigned_labels: set[str] = set()

    for index, path in enumerate(output_files):
        if not path.exists():
            log.write(f"Skipping missing worker output: {path}\n")
            continue

        label = infer_label(path, project_name, expected_stems, assigned_labels, index)
        assigned_labels.add(label)

        destination = output_dir / daw_friendly_stem_filename(project_name, label)
        if path.resolve() != destination.resolve():
            if destination.exists():
                destination.unlink()
            shutil.move(str(path), str(destination))
            log.write(f"Normalized {path.name} to {destination.name}\n")

        stems.append({"label": label, "path": str(destination)})

    expected_order = {label: index for index, label in enumerate(expected_stems)}
    stems.sort(key=lambda stem: expected_order.get(stem["label"], len(expected_order)))
    return stems


def infer_label(
    path: Path,
    project_name: str,
    expected_stems: list[str],
    assigned_labels: set[str],
    index: int,
) -> str:
    stem = path.stem
    sanitized_project = sanitize_name(project_name).casefold()

    for label in expected_stems:
        if label in assigned_labels:
            continue
        if stem.casefold() == daw_friendly_file_stem(project_name, label).casefold():
            return label

    bracket_match = re.search(r"\(([^)]+)\)", stem)
    underscore_match = re.search(r"_([^_()]+)$", stem)
    for match in [bracket_match, underscore_match]:
        if not match:
            continue
        candidate = canonical_label(match.group(1), expected_stems)
        if candidate and candidate not in assigned_labels:
            return candidate

    lowered = stem.casefold().replace(sanitized_project, "")
    for label in expected_stems:
        if label in assigned_labels:
            continue
        if sanitize_name(label).casefold() in lowered or label.casefold() in lowered:
            return label

    for label in expected_stems[index:]:
        if label not in assigned_labels:
            return label

    return sanitize_name(stem).title()


def canonical_label(value: str, expected_stems: list[str]) -> str | None:
    normalized = value.replace("_", " ").replace("-", " ").strip().casefold()
    for label in expected_stems:
        if normalized == label.casefold():
            return label
        for alias in COMMON_STEM_ALIASES.get(label, []):
            if normalized == alias.casefold():
                return label
    return None


def ensure_ffmpeg_on_path(log) -> None:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        log.write("Using system ffmpeg/ffprobe\n\n")
        return

    log.write("ffmpeg/ffprobe were not found on PATH. audio-separator may still work for WAV input, but compressed formats can fail.\n\n")


def daw_friendly_stem_filename(project_name: str, stem_label: str) -> str:
    return f"{daw_friendly_file_stem(project_name, stem_label)}.wav"


def daw_friendly_file_stem(project_name: str, stem_label: str) -> str:
    return f"{sanitize_name(project_name)} - {sanitize_name(stem_label)}"


def sanitize_name(value: str) -> str:
    invalid = set('/\\:*?"<>|')
    cleaned = "".join("-" if character in invalid or ord(character) < 32 else character for character in value)
    cleaned = " ".join(cleaned.split()).strip(". -")
    return cleaned or "Untitled Track"


if __name__ == "__main__":
    raise SystemExit(main())
