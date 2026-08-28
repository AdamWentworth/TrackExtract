# Changelog

All notable changes will be documented here. The project follows Keep a Changelog conventions and intends to use
semantic versioning once the first supported release is published.

## Unreleased

### Security

- Updated vulnerable npm and Rust dependencies.
- Hardened the browser development bridge, local media paths, process-tree cancellation, and model downloads.

### Reliability

- Added atomic JSON persistence, cross-process state locking, guarded job transitions, project-bound jobs, bounded
  waveform work, dependency audits, coverage thresholds, and production bundle budgets.
- Added native cross-platform Python, Rust, Tauri, and full-suite launchers so repository checks run consistently from
  Windows PowerShell and Unix shells.
- Added a constrained NVIDIA CUDA setup with executable PyTorch, ONNX Runtime, and bundled FFmpeg probes.
- Removed unsupported HTDemucs segment controls and safely ignore incompatible values preserved in older workflows.
- Validated real GTX 1070 separation, Windows release compilation, MSI/NSIS bundling, and desktop startup.
