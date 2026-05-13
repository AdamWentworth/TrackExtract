#!/usr/bin/env node
import { readFileSync } from "node:fs";

const workflowsPath = new URL("../resources/workflows.json", import.meta.url);
const modelsPath = new URL("../resources/models.json", import.meta.url);
const workflows = JSON.parse(readFileSync(workflowsPath, "utf8"));
const models = JSON.parse(readFileSync(modelsPath, "utf8"));

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
const workflowKinds = new Set(["preset", "custom", "template"]);
const modelById = new Map(models.map((model) => [model.id, model]));
const errors = [];
const ids = new Set();

if (!Array.isArray(workflows)) {
  fail("Workflow registry must be a JSON array.");
}

for (const [index, workflow] of workflows.entries()) {
  const label = workflow?.id ?? `workflow ${index}`;

  for (const field of ["id", "displayName", "description", "kind", "task", "steps"]) {
    if (!(field in workflow)) {
      errors.push(`${label}: missing required field "${field}".`);
    }
  }

  if (typeof workflow.id !== "string" || workflow.id.trim() === "") {
    errors.push(`workflow ${index}: id must be a non-empty string.`);
  } else if (ids.has(workflow.id)) {
    errors.push(`${workflow.id}: duplicate workflow id.`);
  } else {
    ids.add(workflow.id);
  }

  if (!workflowKinds.has(workflow.kind)) {
    errors.push(`${label}: unsupported kind "${workflow.kind}".`);
  }

  if (!taskTypes.has(workflow.task)) {
    errors.push(`${label}: unsupported task "${workflow.task}".`);
  }

  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push(`${label}: steps must be a non-empty array.`);
    continue;
  }

  const stepIds = new Set();
  for (const [stepIndex, step] of workflow.steps.entries()) {
    const stepLabel = `${label}.steps[${stepIndex}]`;
    if (typeof step.id !== "string" || step.id.trim() === "") {
      errors.push(`${stepLabel}: id must be a non-empty string.`);
    } else if (stepIds.has(step.id)) {
      errors.push(`${label}: duplicate step id "${step.id}".`);
    } else {
      stepIds.add(step.id);
    }

    if (!taskTypes.has(step.task)) {
      errors.push(`${stepLabel}: unsupported task "${step.task}".`);
    }

    const model = modelById.get(step.modelId);
    if (!model) {
      errors.push(`${stepLabel}: unknown model "${step.modelId}".`);
    } else if (!model.tasks.includes(step.task)) {
      errors.push(`${stepLabel}: model "${step.modelId}" does not support task "${step.task}".`);
    }

    if (!step.options || typeof step.options !== "object" || Array.isArray(step.options)) {
      errors.push(`${stepLabel}: options must be an object.`);
    }
  }
}

for (const required of ["quick_vocal_split", "best_vocal_split", "full_6_stem_split", "clean_lead_vocal_uvr_chain"]) {
  if (!ids.has(required)) {
    errors.push(`Missing required workflow "${required}".`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`workflow-registry: ${error}`);
  }
  process.exit(1);
}

console.log(`Validated ${workflows.length} workflow registry entries.`);

function fail(message) {
  console.error(`workflow-registry: ${message}`);
  process.exit(1);
}
