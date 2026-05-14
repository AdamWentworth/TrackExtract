#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(rootDir, "resources", "models");
const outputPath = join(rootDir, "resources", "models.json");
const checkOnly = process.argv.includes("--check");

const sourceFiles = ["demucs.json", "uvr.json", "manual.json", "mvsep.json"];

const models = sourceFiles.flatMap((fileName) => {
  const path = join(sourceDir, fileName);
  if (!existsSync(path)) {
    throw new Error(`Missing model registry source: resources/models/${fileName}`);
  }

  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Model registry source must be a JSON array: resources/models/${fileName}`);
  }
  return parsed;
});

const output = `${JSON.stringify(models, null, 2)}\n`;

if (checkOnly) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (current !== output) {
    console.error("resources/models.json is out of date. Run npm run models:build.");
    process.exit(1);
  }
  console.log(`Model registry is up to date (${models.length} entries).`);
} else {
  writeFileSync(outputPath, output);
  console.log(`Wrote resources/models.json from ${sourceFiles.length} sources (${models.length} entries).`);
}
