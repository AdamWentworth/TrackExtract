from __future__ import annotations

from . import audio_separator, demucs, stub
from ..errors import TrackExtractError


def run_provider(request: dict, emit) -> tuple[list[dict], object]:
    model = request["model"]
    provider = (model.get("runtime") or {}).get("provider")
    if provider == "demucs":
        return demucs.run(request, emit)
    if provider == "audio-separator":
        return audio_separator.run(request, emit)
    if provider == "stub":
        return stub.run(request, emit)
    raise TrackExtractError(f"{model.get('displayName')} is installed, but this model asset is not runnable in TrackExtract yet.")
