#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/cargo-env.sh"

trackextract_source_cargo_env

if [[ "${1:-}" == "--check" || "${1:-}" == "check" ]]; then
  cargo fmt --all -- --check
else
  cargo fmt --all
fi
