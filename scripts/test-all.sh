#!/usr/bin/env bash
set -euo pipefail

if [[ -f "${HOME}/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.cargo/env"
fi

npm run test:models
npm run test:workflows
npm run test:frontend
npm run test:build
npm run test:rust

if [[ "${TRACKEXTRACT_TEST_NETWORK:-0}" == "1" ]]; then
  npm run test:models:network
else
  printf '\nSkipping model URL network checks. Run TRACKEXTRACT_TEST_NETWORK=1 npm run test:all to include them.\n'
fi
