#!/usr/bin/env bash
set -euo pipefail

# VS Code installed through Snap can export GTK/GIO/library paths that make
# Tauri load mixed Snap/system libraries. Strip those while keeping the normal
# desktop session available. On non-Snap terminals these unsets are harmless.
unset SNAP SNAP_ARCH SNAP_COMMON SNAP_CONTEXT SNAP_COOKIE SNAP_DATA SNAP_EUID
unset SNAP_INSTANCE_NAME SNAP_LAUNCHER_ARCH_TRIPLET SNAP_LIBRARY_PATH SNAP_NAME
unset SNAP_REAL_HOME SNAP_REVISION SNAP_UID SNAP_USER_COMMON SNAP_USER_DATA SNAP_VERSION
unset GIO_LAUNCHED_DESKTOP_FILE GIO_LAUNCHED_DESKTOP_FILE_PID GIO_MODULE_DIR
unset GTK_EXE_PREFIX GTK_IM_MODULE_FILE GTK_MODULES GTK_PATH

export XDG_DATA_DIRS="${XDG_DATA_DIRS_VSCODE_SNAP_ORIG:-${XDG_DATA_DIRS:-/usr/share/ubuntu:/usr/share/gnome:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop}}"
export XDG_CONFIG_DIRS="${XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG:-${XDG_CONFIG_DIRS:-/etc/xdg/xdg-ubuntu:/etc/xdg}}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
export GTK_OVERLAY_SCROLLING=0

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT_DIR/node_modules/.bin:$PATH"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/cargo-env.sh"

trackextract_source_cargo_env

exec tauri "$@"
