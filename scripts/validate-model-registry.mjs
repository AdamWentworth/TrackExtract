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

const backendKinds = new Set(["stub", "onnx", "pytorch-worker", "external-process", "python-engine"]);
const installMethods = new Set(["direct-url", "audio-separator", "source-only"]);
const optionTypes = new Set(["select", "integer", "number", "boolean"]);
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

const requiredCatalogModels = new Set([
  "uvr_onnx_uvr_mdxnet_1_9703",
  "uvr_onnx_uvr_mdxnet_main",
  "uvr_onnx_uvr_mdx_net_inst_main",
  "uvr_onnx_uvr_mdx_net_crowd_hq_1",
  "uvr_vr_uvr_de_echo_aggressive",
  "uvr_vr_uvr_denoise_lite",
  "uvr_ckpt_model_bs_roformer_ep_317_sdr_12_9755",
  "uvr_ckpt_melband_roformer_instvoc_duality_v1",
  "mvsep_bs_roformer_sw",
  "mvsep_bs_polarformer_vocals",
  "mvsep_melband_roformer_vocals",
  "mvsep_scnet_vocals",
  "mvsep_drumsep",
  "mvsep_reverb_removal",
  "mvsep_denoise_aufr33_gabox",
  "mvsep_phantom_centre",
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

    if (model.installMethod !== undefined && !installMethods.has(model.installMethod)) {
      errors.push(`${label}: unsupported installMethod "${model.installMethod}".`);
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

    if (model.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(model.sha256)) {
      errors.push(`${label}: sha256 must be a 64-character hexadecimal digest when present.`);
    }

    if (model.options !== undefined) {
      validateOptions(label, model.options);
    }

    if (model.runtime !== undefined) {
      validateRuntime(label, model.runtime);
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

    if (
      model.installed &&
      model.path &&
      !managedDownload &&
      !existsSync(new URL(`../${model.path}`, import.meta.url))
    ) {
      errors.push(`${label}: installed local path does not exist in repo: ${model.path}`);
    }
  }
}

for (const modelId of requiredVocalCleanupModels) {
  if (!ids.has(modelId)) {
    errors.push(`Missing required vocal cleanup model "${modelId}".`);
  }
}

for (const modelId of requiredCatalogModels) {
  if (!ids.has(modelId)) {
    errors.push(`Missing required catalog model "${modelId}".`);
  }
}

const publicUvrModelCount = registry.filter(
  (model) =>
    model.sourceUrl === "https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models" &&
    model.path?.startsWith("models/") &&
    model.downloadUrl?.startsWith("https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/"),
).length;
if (publicUvrModelCount < 72) {
  errors.push(`Expected at least 72 public UVR downloadable model entries, found ${publicUvrModelCount}.`);
}

const mvsepCatalogCount = registry.filter(
  (model) => model.sourceUrl === "https://mvsep.com/en" && model.path === "" && model.backend === "external-process",
).length;
if (mvsepCatalogCount < 95) {
  errors.push(`Expected at least 95 MVSEP catalog entries, found ${mvsepCatalogCount}.`);
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

function validateOptions(label, options) {
  if (!Array.isArray(options)) {
    errors.push(`${label}: options must be an array when present.`);
    return;
  }

  const optionIds = new Set();
  for (const [index, option] of options.entries()) {
    const optionLabel = `${label}.options[${index}]`;
    if (typeof option.id !== "string" || option.id.trim() === "") {
      errors.push(`${optionLabel}: id must be a non-empty string.`);
    } else if (optionIds.has(option.id)) {
      errors.push(`${label}: duplicate option id "${option.id}".`);
    } else {
      optionIds.add(option.id);
    }

    if (typeof option.displayName !== "string" || option.displayName.trim() === "") {
      errors.push(`${optionLabel}: displayName must be a non-empty string.`);
    }

    if (!optionTypes.has(option.type)) {
      errors.push(`${optionLabel}: unsupported option type "${option.type}".`);
      continue;
    }

    if (!("defaultValue" in option)) {
      errors.push(`${optionLabel}: missing defaultValue.`);
    }

    if (option.type === "select") {
      if (!Array.isArray(option.choices) || option.choices.length === 0) {
        errors.push(`${optionLabel}: select options require choices.`);
      } else if (!option.choices.some((choice) => choice.value === option.defaultValue)) {
        errors.push(`${optionLabel}: defaultValue must match a select choice.`);
      }
    }

    if (option.type === "integer" && !Number.isInteger(option.defaultValue)) {
      errors.push(`${optionLabel}: integer defaultValue must be an integer.`);
    }

    if (option.type === "number" && typeof option.defaultValue !== "number") {
      errors.push(`${optionLabel}: number defaultValue must be numeric.`);
    }

    if (option.type === "boolean" && typeof option.defaultValue !== "boolean") {
      errors.push(`${optionLabel}: boolean defaultValue must be boolean.`);
    }

    if (option.min !== undefined && typeof option.min !== "number") {
      errors.push(`${optionLabel}: min must be numeric when present.`);
    }

    if (option.max !== undefined && typeof option.max !== "number") {
      errors.push(`${optionLabel}: max must be numeric when present.`);
    }

    if (typeof option.defaultValue === "number") {
      if (typeof option.min === "number" && option.defaultValue < option.min) {
        errors.push(`${optionLabel}: defaultValue is below min.`);
      }
      if (typeof option.max === "number" && option.defaultValue > option.max) {
        errors.push(`${optionLabel}: defaultValue is above max.`);
      }
    }
  }
}

function validateRuntime(label, runtime) {
  if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) {
    errors.push(`${label}: runtime must be an object when present.`);
    return;
  }

  if (runtime.provider !== undefined && typeof runtime.provider !== "string") {
    errors.push(`${label}: runtime.provider must be a string when present.`);
  }

  if (runtime.modelFilename !== undefined && typeof runtime.modelFilename !== "string") {
    errors.push(`${label}: runtime.modelFilename must be a string when present.`);
  }
}
