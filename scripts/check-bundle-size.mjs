#!/usr/bin/env node

import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const assetDirectory = path.resolve("dist/assets");
const assets = readdirSync(assetDirectory);
const budgets = [
  { extension: ".js", maximum: 110 * 1024, label: "JavaScript" },
  { extension: ".css", maximum: 10 * 1024, label: "CSS" },
];

let failed = false;
for (const budget of budgets) {
  const bytes = assets
    .filter((file) => file.endsWith(budget.extension))
    .reduce((total, file) => total + gzipSync(readFileSync(path.join(assetDirectory, file))).byteLength, 0);
  const kib = (bytes / 1024).toFixed(1);
  const maximumKib = (budget.maximum / 1024).toFixed(0);
  console.log(`${budget.label}: ${kib} KiB gzip (budget ${maximumKib} KiB)`);
  if (bytes > budget.maximum) {
    failed = true;
  }
}

if (failed) {
  console.error("Production bundle exceeds its checked-in performance budget.");
  process.exit(1);
}
