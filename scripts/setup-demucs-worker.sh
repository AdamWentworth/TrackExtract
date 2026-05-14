#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "TrackExtract now uses one managed Python engine environment."
echo "Running scripts/setup-trackextract-engine.sh instead."
exec "$ROOT_DIR/scripts/setup-trackextract-engine.sh"
