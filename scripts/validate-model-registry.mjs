#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, normalize, sep } from "node:path";

const registryPath = new URL("../resources/models.json", import.meta.url);
const registry = JSON.parse(readFileSync(registryPath, "utf8"));

const taskTypes = new Set([
  "vocals_instrumental",
  "full_stem_split",
  "drums_only",
  "bass_only",
  "guitar_only",
  "piano_only",
  "experimental_best_quality",
  "vocal_cleanup_chain",
  "layered_vocal_cleanup",
  "vocal_dereverb",
  "vocal_denoise",
]);

const backendKinds = new Set(["stub", "onnx", "pytorch-worker", "external-process"]);
const deprecatedIds = new Set([
  "stub_full_stem_split",
  "stub_vocals_instrumental",
  "onnx_roformer_full_split_placeholder",
  "onnx_mdx_vocals_placeholder",
  "pytorch_demucs_experimental_placeholder",
]);

const requiredVocalCleanupModels = new Set([
  "uvr_mdx23c_instvoc_hq",
  "onnx_uvr_mdxnet_karaoke_2",
  "onnx_uvr_mdxnet_voc_ft",
  "onnx_reverb_hq_by_foxjoy",
  "uvr_denoise",
]);

const requiredFields = [
  "id",
  "displayName",
  "backend",
  "tasks",
  "stems",
  "sampleRate",
  "quality",
  "version",
  "installed",
  "path",
];

const errors = [];
const ids = new Set();

if (!Array.isArray(registry)) {
  fail("Registry must be a JSON array.");
} else {
  for (const [index, model] of registry.entries()) {
    const label = model?.id ?? `entry ${index}`;
    for (const field of requiredFields) {
      if (!(field in model)) {
        errors.push(`${label}: missing required field "${field}".`);
      }
    }

    if (typeof model.id !== "string" || model.id.trim() === "") {
      errors.push(`entry ${index}: id must be a non-empty string.`);
    } else if (ids.has(model.id)) {
      errors.push(`${model.id}: duplicate model id.`);
    } else {
      ids.add(model.id);
    }

    if (deprecatedIds.has(model.id)) {
      errors.push(`${model.id}: deprecated prototype model id must not be shipped.`);
    }

    if (!backendKinds.has(model.backend)) {
      errors.push(`${label}: unsupported backend "${model.backend}".`);
    }

    if (!Array.isArray(model.tasks) || model.tasks.length === 0) {
      errors.push(`${label}: tasks must be a non-empty array.`);
    } else {
      for (const task of model.tasks) {
        if (!taskTypes.has(task)) {
          errors.push(`${label}: unsupported task "${task}".`);
        }
      }
    }

    if (!Array.isArray(model.stems) || model.stems.length === 0) {
      errors.push(`${label}: stems must be a non-empty array.`);
    }

    if (!Number.isInteger(model.sampleRate) || model.sampleRate < 8000) {
      errors.push(`${label}: sampleRate must be an integer >= 8000.`);
    }

    if (typeof model.installed !== "boolean") {
      errors.push(`${label}: installed must be boolean.`);
    }

    if (model.downloadSizeMb !== undefined && (!Number.isInteger(model.downloadSizeMb) || model.downloadSizeMb <= 0)) {
      errors.push(`${label}: downloadSizeMb must be a positive integer when present.`);
    }

    if (model.path && isUnsafeRelativePath(model.path)) {
      errors.push(`${label}: path must not be absolute or escape app data: ${model.path}`);
    }

    const managedDownload = typeof model.path === "string" && model.path.startsWith("models/");
    if (managedDownload) {
      if (model.installed) {
        errors.push(`${label}: managed downloadable catalog entries should ship as installed=false.`);
      }
      if (!model.downloadUrl?.startsWith("https://")) {
        errors.push(`${label}: managed downloadable entries need an https downloadUrl.`);
      }
      if (!model.downloadSizeMb) {
        errors.push(`${label}: managed downloadable entries need downloadSizeMb for UI progress estimates.`);
      }
    }

    if (model.installed && model.path && !managedDownload && !existsSync(new URL(`../${model.path}`, import.meta.url))) {
      errors.push(`${label}: installed local path does not exist in repo: ${model.path}`);
    }
  }
}

for (const modelId of requiredVocalCleanupModels) {
  if (!ids.has(modelId)) {
    errors.push(`Missing required vocal cleanup model "${modelId}".`);
  }
}

if (!registry.some((model) => model.tasks?.includes("vocal_cleanup_chain"))) {
  errors.push("At least one model must support vocal_cleanup_chain.");
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`model-registry: ${error}`);
  }
  process.exit(1);
}

console.log(`Validated ${registry.length} model registry entries.`);

function isUnsafeRelativePath(value) {
  if (isAbsolute(value)) {
    return true;
  }

  const normalized = normalize(value);
  return normalized === ".." || normalized.startsWith(`..${sep}`);
}

function fail(message) {
  console.error(`model-registry: ${message}`);
  process.exit(1);
}
