#!/usr/bin/env bash
set -euo pipefail

if [[ -f "${HOME}/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.cargo/env"
fi

if [[ "${1:-}" == "--check" || "${1:-}" == "check" ]]; then
  cargo fmt --all -- --check
else
  cargo fmt --all
fi
