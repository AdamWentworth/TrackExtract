#!/usr/bin/env node
import { readFileSync } from "node:fs";

const registryPath = new URL("../resources/models.json", import.meta.url);
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const downloadableModels = registry.filter((model) => model.path?.startsWith("models/") && model.downloadUrl);

const failures = [];

for (const model of downloadableModels) {
  try {
    const response = await fetchWithTimeout(model.downloadUrl, { method: "HEAD" }, 20_000);
    if (!response.ok) {
      failures.push(`${model.id}: HTTP ${response.status} ${response.statusText}`);
      continue;
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (model.downloadSizeMb && contentLength > 0) {
      const expectedBytes = model.downloadSizeMb * 1024 * 1024;
      const lowerBound = expectedBytes * 0.75;
      const upperBound = expectedBytes * 1.35;
      if (contentLength < lowerBound || contentLength > upperBound) {
        failures.push(
          `${model.id}: content length ${contentLength} is not near catalog estimate ${expectedBytes}`,
        );
      }
    }

    console.log(`${model.id}: ${response.status} ${formatBytes(contentLength)}`);
  } catch (error) {
    failures.push(`${model.id}: ${error}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`model-url: ${failure}`);
  }
  process.exit(1);
}

console.log(`Checked ${downloadableModels.length} downloadable model URLs.`);

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatBytes(bytes) {
  if (!bytes) {
    return "unknown size";
  }

  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}
