import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = { ...process.env };

if (process.platform === "linux") {
  for (const name of [
    "SNAP",
    "SNAP_ARCH",
    "SNAP_COMMON",
    "SNAP_CONTEXT",
    "SNAP_COOKIE",
    "SNAP_DATA",
    "SNAP_EUID",
    "SNAP_INSTANCE_NAME",
    "SNAP_LAUNCHER_ARCH_TRIPLET",
    "SNAP_LIBRARY_PATH",
    "SNAP_NAME",
    "SNAP_REAL_HOME",
    "SNAP_REVISION",
    "SNAP_UID",
    "SNAP_USER_COMMON",
    "SNAP_USER_DATA",
    "SNAP_VERSION",
    "GIO_LAUNCHED_DESKTOP_FILE",
    "GIO_LAUNCHED_DESKTOP_FILE_PID",
    "GIO_MODULE_DIR",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GTK_MODULES",
    "GTK_PATH",
  ]) {
    delete environment[name];
  }
  environment.XDG_DATA_DIRS =
    environment.XDG_DATA_DIRS_VSCODE_SNAP_ORIG ||
    environment.XDG_DATA_DIRS ||
    "/usr/share/ubuntu:/usr/share/gnome:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop";
  environment.XDG_CONFIG_DIRS =
    environment.XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG || environment.XDG_CONFIG_DIRS || "/etc/xdg/xdg-ubuntu:/etc/xdg";
  environment.XDG_DATA_HOME = environment.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  environment.GTK_OVERLAY_SCROLLING = "0";
}

const cargoBin = path.join(os.homedir(), ".cargo", "bin");
if (existsSync(cargoBin)) {
  const pathKey = Object.keys(environment).find((name) => name.toLowerCase() === "path") || "PATH";
  environment[pathKey] = `${cargoBin}${path.delimiter}${environment[pathKey] || ""}`;
}

const tauriEntryPoint = path.join(rootDirectory, "node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(tauriEntryPoint)) {
  throw new Error("Tauri CLI is not installed; run npm install first");
}

const result = spawnSync(process.execPath, [tauriEntryPoint, ...process.argv.slice(2)], {
  cwd: rootDirectory,
  env: environment,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
