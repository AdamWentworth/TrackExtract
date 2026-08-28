import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmEntryPoint = process.env.npm_execpath;

if (!npmEntryPoint) {
  throw new Error("npm_execpath is unavailable; run this orchestrator through npm run test:all");
}

function runScript(name) {
  const result = spawnSync(process.execPath, [npmEntryPoint, "run", name], {
    cwd: rootDirectory,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const script of [
  "test:models",
  "test:workflows",
  "test:engine",
  "test:frontend",
  "test:build",
  "test:bundle",
  "test:rust",
]) {
  runScript(script);
}

if (process.env.TRACKEXTRACT_TEST_NETWORK === "1") {
  runScript("test:models:network");
} else {
  console.log("\nSkipping model URL network checks. Set TRACKEXTRACT_TEST_NETWORK=1 to include them.");
}
