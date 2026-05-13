use std::{collections::HashSet, fs, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{error::Result, model_registry::TaskType};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEntry {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub kind: WorkflowKind,
    pub task: TaskType,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowKind {
    Preset,
    Custom,
    Template,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    pub id: String,
    pub display_name: String,
    pub task: TaskType,
    pub model_id: String,
    #[serde(default)]
    pub input_stem: String,
    #[serde(default)]
    pub output_stems: Vec<String>,
    #[serde(default)]
    pub options: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkflowRegistry {
    pub workflows: Vec<WorkflowEntry>,
}

impl WorkflowRegistry {
    pub fn from_json_str(json: &str) -> Result<Self> {
        let workflows: Vec<WorkflowEntry> = serde_json::from_str(json)?;
        Ok(Self { workflows })
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_json_str(&fs::read_to_string(path)?)
    }

    pub fn save(&self, path: impl AsRef<Path>) -> Result<()> {
        fs::write(path, serde_json::to_string_pretty(&self.workflows)?)?;
        Ok(())
    }

    pub fn sync_with_bundled(&mut self, bundled: &Self) -> bool {
        let mut known_ids = self
            .workflows
            .iter()
            .map(|workflow| workflow.id.clone())
            .collect::<HashSet<_>>();
        let mut changed = false;

        for workflow in &bundled.workflows {
            if let Some(existing) = self
                .workflows
                .iter_mut()
                .find(|existing| existing.id == workflow.id)
            {
                if existing.kind != WorkflowKind::Custom && existing != workflow {
                    *existing = workflow.clone();
                    changed = true;
                }
            } else if known_ids.insert(workflow.id.clone()) {
                self.workflows.push(workflow.clone());
                changed = true;
            }
        }

        changed
    }

    pub fn upsert_custom(&mut self, mut workflow: WorkflowEntry) {
        workflow.kind = WorkflowKind::Custom;
        if let Some(existing) = self
            .workflows
            .iter_mut()
            .find(|existing| existing.id == workflow.id)
        {
            *existing = workflow;
        } else {
            self.workflows.push(workflow);
        }
    }

    pub fn find(&self, workflow_id: &str) -> Option<WorkflowEntry> {
        self.workflows
            .iter()
            .find(|workflow| workflow.id == workflow_id)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_workflow_registry() {
        let registry = WorkflowRegistry::from_json_str(
            r#"[
              {
                "id": "quick",
                "displayName": "Quick",
                "description": "Quick workflow",
                "kind": "preset",
                "task": "vocals_instrumental",
                "steps": [
                  {
                    "id": "split",
                    "displayName": "Split",
                    "task": "vocals_instrumental",
                    "modelId": "demucs",
                    "options": { "device": "auto" }
                  }
                ]
              }
            ]"#,
        )
        .expect("workflow registry");

        assert_eq!(registry.workflows.len(), 1);
        assert_eq!(registry.workflows[0].steps[0].model_id, "demucs");
    }

    #[test]
    fn rejects_missing_required_fields() {
        let error =
            WorkflowRegistry::from_json_str(r#"[{"id":"broken"}]"#).expect_err("missing fields");

        assert!(error.to_string().contains("missing field"));
    }

    #[test]
    fn sync_updates_presets_but_keeps_custom_workflows() {
        let mut local = WorkflowRegistry::from_json_str(
            r#"[
              {
                "id": "quick",
                "displayName": "Old Quick",
                "description": "Old",
                "kind": "preset",
                "task": "vocals_instrumental",
                "steps": [
                  {
                    "id": "split",
                    "displayName": "Split",
                    "task": "vocals_instrumental",
                    "modelId": "old",
                    "options": {}
                  }
                ]
              },
              {
                "id": "my_chain",
                "displayName": "My Chain",
                "description": "User workflow",
                "kind": "custom",
                "task": "vocals_instrumental",
                "steps": [
                  {
                    "id": "split",
                    "displayName": "Split",
                    "task": "vocals_instrumental",
                    "modelId": "custom",
                    "options": {}
                  }
                ]
              }
            ]"#,
        )
        .expect("local");
        let bundled = WorkflowRegistry::from_json_str(
            r#"[
              {
                "id": "quick",
                "displayName": "Quick",
                "description": "New",
                "kind": "preset",
                "task": "vocals_instrumental",
                "steps": [
                  {
                    "id": "split",
                    "displayName": "Split",
                    "task": "vocals_instrumental",
                    "modelId": "demucs",
                    "options": {}
                  }
                ]
              }
            ]"#,
        )
        .expect("bundled");

        assert!(local.sync_with_bundled(&bundled));
        assert_eq!(local.find("quick").expect("quick").display_name, "Quick");
        assert_eq!(
            local
                .find("my_chain")
                .expect("custom")
                .steps
                .first()
                .expect("step")
                .model_id,
            "custom"
        );
    }
}
