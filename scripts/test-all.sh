#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/cargo-env.sh"

trackextract_source_cargo_env

npm run test:models
npm run test:workflows
npm run test:engine
npm run test:frontend
npm run test:build
npm run test:rust

if [[ "${TRACKEXTRACT_TEST_NETWORK:-0}" == "1" ]]; then
  npm run test:models:network
else
  printf '\nSkipping model URL network checks. Run TRACKEXTRACT_TEST_NETWORK=1 npm run test:all to include them.\n'
fi
