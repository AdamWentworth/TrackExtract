#!/usr/bin/env bash
set -euo pipefail

if [[ -f "${HOME}/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.cargo/env"
fi

cargo fmt --all -- --check
cargo test
