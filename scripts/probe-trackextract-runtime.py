#!/usr/bin/env python3
"""Validate that an installed Track Extract runtime can execute its workload."""

from __future__ import annotations

import argparse
import importlib.util
import shutil
import time
from importlib import metadata


def package_version(name: str) -> str:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return "unavailable"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect", choices=("cpu", "gpu", "dml"), required=True)
    args = parser.parse_args()

    require(
        importlib.util.find_spec("trackextract_engine") is not None,
        "trackextract_engine is not importable",
    )
    for package in ("trackextract-engine", "demucs", "audio-separator"):
        print(f"{package}: {package_version(package)}")

    import static_ffmpeg

    static_ffmpeg.add_paths()
    for command in ("ffmpeg", "ffprobe"):
        path = shutil.which(command)
        require(path is not None, f"{command} is unavailable after static-ffmpeg setup")
        print(f"{command}: {path}")

    import torch

    print(f"torch: {torch.__version__}")

    if args.expect == "gpu":
        require(
            torch.cuda.is_available(),
            "GPU runtime requested, but PyTorch CUDA is unavailable",
        )
        print(f"CUDA build: {torch.version.cuda}")
        print(f"CUDA device: {torch.cuda.get_device_name(0)}")
        print(f"CUDA architectures: {', '.join(torch.cuda.get_arch_list())}")

        started = time.perf_counter()
        left = torch.randn((1024, 1024), device="cuda")
        right = torch.randn((1024, 1024), device="cuda")
        result = left @ right
        torch.cuda.synchronize()
        print(
            f"CUDA tensor probe: {time.perf_counter() - started:.3f}s ({result[0, 0].item():.6f})"
        )
        print(
            f"CUDA peak allocation: {torch.cuda.max_memory_allocated() / 1024 / 1024:.1f} MiB"
        )

        import onnxruntime

        providers = onnxruntime.get_available_providers()
        print(f"ONNX Runtime providers: {', '.join(providers)}")
        require(
            "CUDAExecutionProvider" in providers,
            "GPU runtime requested, but ONNX Runtime's CUDA provider is unavailable",
        )
    elif args.expect == "dml":
        require(
            importlib.util.find_spec("torch_directml") is not None,
            "DirectML runtime requested, but torch-directml is unavailable",
        )
    else:
        print(f"CUDA available: {torch.cuda.is_available()}")


if __name__ == "__main__":
    main()
