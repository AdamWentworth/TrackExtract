#!/usr/bin/env bash
set -euo pipefail

# VS Code installed through Snap exports GTK/GIO paths that can make Tauri load
# mixed Snap/system libraries. Strip those while keeping the desktop session.
unset SNAP SNAP_ARCH SNAP_COMMON SNAP_CONTEXT SNAP_COOKIE SNAP_DATA SNAP_EUID
unset SNAP_INSTANCE_NAME SNAP_LAUNCHER_ARCH_TRIPLET SNAP_LIBRARY_PATH SNAP_NAME
unset SNAP_REAL_HOME SNAP_REVISION SNAP_UID SNAP_USER_COMMON SNAP_USER_DATA SNAP_VERSION
unset GIO_LAUNCHED_DESKTOP_FILE GIO_LAUNCHED_DESKTOP_FILE_PID GIO_MODULE_DIR
unset GTK_EXE_PREFIX GTK_IM_MODULE_FILE GTK_MODULES GTK_PATH

export XDG_DATA_DIRS="${XDG_DATA_DIRS_VSCODE_SNAP_ORIG:-/usr/share/ubuntu:/usr/share/gnome:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop}"
export XDG_CONFIG_DIRS="${XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG:-/etc/xdg/xdg-ubuntu:/etc/xdg}"
export XDG_DATA_HOME="${HOME}/.local/share"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/cargo-env.sh"

trackextract_source_cargo_env

npm run tauri dev
