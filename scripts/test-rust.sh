#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/cargo-env.sh"

trackextract_source_cargo_env

if [[ "${1:-}" == "--lint-only" ]]; then
  cargo clippy --workspace --all-targets -- -D warnings
  exit 0
fi

cargo test
