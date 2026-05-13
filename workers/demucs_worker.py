#!/usr/bin/env python3
"""TrackExtract Demucs sidecar worker.

This script is intentionally small and process-oriented. The Tauri UI never
talks to Python directly; Rust launches this worker through the backend trait
and receives a JSON result file with the final stem paths.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import traceback
import wave
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Demucs for TrackExtract")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--result-json", required=True)
    parser.add_argument("--log-path", required=True)
    parser.add_argument("--project-name", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--mode", required=True)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    log_path = Path(args.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with log_path.open("w", encoding="utf-8", buffering=1) as log:
        try:
            return run(args, log)
        except Exception:
            log.write("\nTrackExtract Demucs worker crashed:\n")
            traceback.print_exc(file=log)
            return 1


def run(args: argparse.Namespace, log) -> int:
    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    work_dir = Path(args.work_dir)
    result_json = Path(args.result_json)

    output_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    result_json.parent.mkdir(parents=True, exist_ok=True)

    log.write(f"TrackExtract Demucs worker job {args.job_id}\n")
    log.write(f"Input: {input_path}\n")
    log.write(f"Task: {args.task}\n")
    log.write(f"Model: {args.model}\n")
    log.write(f"Mode: {args.mode}\n")
    log.write(f"Device: {args.device}\n\n")

    ensure_ffmpeg_on_path(log)

    stems = separate_with_demucs(args, input_path, output_dir, log)

    result_json.write_text(json.dumps({"stems": stems}, indent=2), encoding="utf-8")
    log.write("\nComplete\n")
    return 0


def separate_with_demucs(
    args: argparse.Namespace,
    input_path: Path,
    output_dir: Path,
    log,
) -> list[dict[str, str]]:
    import torch
    from demucs.apply import apply_model
    from demucs.audio import AudioFile, prevent_clip
    from demucs.pretrained import get_model

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"

    log.write(f"Loading Demucs model {args.model}\n")
    model = get_model(args.model)

    model.cpu()
    model.eval()

    if args.mode != "full" and args.mode not in model.sources:
        sources = ", ".join(model.sources)
        raise RuntimeError(f'Stem "{args.mode}" is not in selected model. Available: {sources}')

    log.write(
        f"Decoding audio at {model.samplerate} Hz with {model.audio_channels} channels\n"
    )
    wav = AudioFile(input_path).read(
        streams=0,
        samplerate=model.samplerate,
        channels=model.audio_channels,
    )

    ref = wav.mean(0)
    wav -= ref.mean()
    wav /= ref.std()

    log.write(f"Running Demucs on {device}\n")
    sources = apply_model(
        model,
        wav[None],
        device=device,
        shifts=1,
        split=True,
        overlap=0.25,
        progress=False,
        num_workers=0,
        segment=None,
    )[0]
    sources *= ref.std()
    sources += ref.mean()

    stem_tensors = []
    if args.mode == "full":
        for source, name in zip(sources, model.sources):
            stem_tensors.append((source_label(name), source))
    else:
        source_list = list(sources)
        selected_index = model.sources.index(args.mode)
        selected_source = source_list.pop(selected_index)
        other_source = torch.zeros_like(source_list[0])
        for source in source_list:
            other_source += source

        stem_tensors.append((source_label(args.mode), selected_source))
        stem_tensors.append((inverse_source_label(args.mode), other_source))

    stems = []
    for label, tensor in stem_tensors:
        destination = output_dir / daw_friendly_stem_filename(args.project_name, label)
        save_wav_tensor(prevent_clip(tensor, mode="rescale"), destination, model.samplerate)
        log.write(f"Wrote {label}: {destination}\n")
        stems.append({"label": label, "path": str(destination)})

    return stems


def save_wav_tensor(tensor, destination: Path, sample_rate: int) -> None:
    import numpy as np

    destination.parent.mkdir(parents=True, exist_ok=True)
    tensor = tensor.detach().cpu().clamp(-1, 1)
    if tensor.ndim == 1:
        tensor = tensor[None, :]

    channels = int(tensor.shape[0])
    samples = tensor.transpose(0, 1).numpy()
    pcm = (samples * 32767.0).astype(np.int16)

    with wave.open(str(destination), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def source_label(source: str) -> str:
    return {
        "vocals": "Vocals",
        "drums": "Drums",
        "bass": "Bass",
        "guitar": "Guitar",
        "piano": "Piano",
        "other": "Other",
    }.get(source, source.replace("_", " ").title())


def inverse_source_label(source: str) -> str:
    if source == "vocals":
        return "Instrumental"
    return f"No {source_label(source)}"


def ensure_ffmpeg_on_path(log) -> None:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        log.write("Using system ffmpeg/ffprobe\n\n")
        return

    try:
        import static_ffmpeg

        static_ffmpeg.add_paths(weak=True)
    except Exception as error:
        log.write(f"Could not prepare bundled ffmpeg: {error}\n\n")
        return

    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        log.write("Using static-ffmpeg ffmpeg/ffprobe\n\n")
    else:
        log.write("ffmpeg/ffprobe are still unavailable\n\n")


def expected_stems(mode: str) -> list[tuple[str, list[str]]]:
    if mode == "vocals":
        return [
            ("Vocals", ["vocals.wav"]),
            ("Instrumental", ["no_vocals.wav", "accompaniment.wav"]),
        ]

    if mode == "full":
        return [
            ("Vocals", ["vocals.wav"]),
            ("Drums", ["drums.wav"]),
            ("Bass", ["bass.wav"]),
            ("Guitar", ["guitar.wav"]),
            ("Piano", ["piano.wav"]),
            ("Other", ["other.wav"]),
        ]

    label = mode.replace("_", " ").title()
    return [(label, [f"{mode}.wav"])]


def find_generated_file(files: list[Path], names: list[str]) -> Path | None:
    lower_names = {name.lower() for name in names}
    for path in files:
        if path.name.lower() in lower_names:
            return path
    return None


def daw_friendly_stem_filename(project_name: str, stem_label: str) -> str:
    return f"{sanitize_name(project_name)} - {sanitize_name(stem_label)}.wav"


def sanitize_name(value: str) -> str:
    invalid = set('/\\:*?"<>|')
    cleaned = "".join("-" if character in invalid or ord(character) < 32 else character for character in value)
    cleaned = " ".join(cleaned.split()).strip(". -")
    return cleaned or "Untitled Track"


if __name__ == "__main__":
    raise SystemExit(main())
