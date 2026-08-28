import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const supportedModes = new Set(["format", "format-check", "lint", "test"]);

if (!supportedModes.has(mode)) {
  throw new Error(`Expected one of: ${[...supportedModes].join(", ")}`);
}

const defaultVenvName = process.platform === "win32" ? ".venv-python-tests-win" : ".venv-python-tests";
const configuredVenv = process.env.TRACKEXTRACT_TEST_VENV || defaultVenvName;
const venvDirectory = path.resolve(rootDirectory, configuredVenv);
const venvPython = path.join(
  venvDirectory,
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: rootDirectory,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandSucceeds(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: rootDirectory,
    env: process.env,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

if (!existsSync(venvPython)) {
  const basePython = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  run(basePython, ["-m", "venv", venvDirectory]);
}

if (!commandSucceeds(venvPython, ["-m", "pip", "--version"])) {
  throw new Error(`Python test environment is missing pip; recreate ${venvDirectory}`);
}

run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
run(venvPython, ["-m", "pip", "install", "--quiet", "-e", `${path.join(rootDirectory, "engine")}[dev]`]);

if (mode === "format") {
  run(venvPython, ["-m", "ruff", "check", "--select", "I", "--fix", path.join(rootDirectory, "engine")]);
  run(venvPython, ["-m", "ruff", "format", path.join(rootDirectory, "engine")]);
} else if (mode === "format-check") {
  run(venvPython, ["-m", "ruff", "format", "--check", path.join(rootDirectory, "engine")]);
  run(venvPython, ["-m", "ruff", "check", "--select", "I", path.join(rootDirectory, "engine")]);
} else if (mode === "lint") {
  run(venvPython, ["-m", "ruff", "check", path.join(rootDirectory, "engine")]);
} else {
  const coverageDirectory = path.join(rootDirectory, ".artifacts", "coverage", "python");
  mkdirSync(coverageDirectory, { recursive: true });
  run(venvPython, [
    "-m",
    "pytest",
    `--cov=${path.join(rootDirectory, "engine", "src")}`,
    "--cov-branch",
    "--cov-report=term-missing:skip-covered",
    `--cov-report=json:${path.join(coverageDirectory, "coverage.json")}`,
    "--cov-fail-under=50",
    path.join(rootDirectory, "engine", "tests"),
  ]);
}
