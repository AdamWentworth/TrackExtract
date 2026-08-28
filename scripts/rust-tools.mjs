import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const supportedModes = new Set(["format", "format-check", "lint", "test"]);

if (!supportedModes.has(mode)) {
  throw new Error(`Expected one of: ${[...supportedModes].join(", ")}`);
}

const userCargo = path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
const cargo = process.env.CARGO || (existsSync(userCargo) ? userCargo : "cargo");

const cargoArguments = {
  format: ["fmt", "--all"],
  "format-check": ["fmt", "--all", "--", "--check"],
  lint: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
  test: ["test"],
}[mode];

const result = spawnSync(cargo, cargoArguments, {
  cwd: rootDirectory,
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
