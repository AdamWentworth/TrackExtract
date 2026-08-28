import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const runRoot = path.join(repoRoot, ".artifacts", "performance", String(process.pid));
const enginePython =
  process.env.TRACKEXTRACT_ENGINE_PYTHON ??
  path.join(
    repoRoot,
    process.platform === "win32" ? ".venv-python-tests-win" : ".venv-python-tests",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );

export default defineConfig({
  testDir: "./tests/performance",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4195",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev:browser -- --host 127.0.0.1 --port 4195 --strictPort",
    env: {
      TRACKEXTRACT_APP_DATA_DIR: path.join(runRoot, "app-data"),
      TRACKEXTRACT_ENGINE_PYTHON: enginePython,
      TRACKEXTRACT_PROJECT_ROOT: path.join(runRoot, "projects"),
      VITE_TRACKEXTRACT_DEV_BRIDGE_PORT: "4195",
    },
    url: "http://127.0.0.1:4195",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
