use std::{collections::HashSet, fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    VocalsInstrumental,
    FullStemSplit,
    DrumsOnly,
    BassOnly,
    GuitarOnly,
    PianoOnly,
    ExperimentalBestQuality,
}

impl TaskType {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::VocalsInstrumental => "Vocals / Instrumental",
            Self::FullStemSplit => "Full Stem Split",
            Self::DrumsOnly => "Drums Only",
            Self::BassOnly => "Bass Only",
            Self::GuitarOnly => "Guitar Only",
            Self::PianoOnly => "Piano Only",
            Self::ExperimentalBestQuality => "Experimental / Best Quality",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum BackendKind {
    #[serde(rename = "stub")]
    Stub,
    #[serde(rename = "onnx")]
    Onnx,
    #[serde(rename = "pytorch-worker")]
    PytorchWorker,
    #[serde(rename = "external-process")]
    ExternalProcess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub display_name: String,
    pub backend: BackendKind,
    pub tasks: Vec<TaskType>,
    pub stems: Vec<String>,
    pub sample_rate: u32,
    pub quality: String,
    pub version: String,
    pub installed: bool,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub download_url: String,
    #[serde(default)]
    pub runtime: ModelRuntimeConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelRuntimeConfig {
    #[serde(default)]
    pub worker_script: String,
    #[serde(default)]
    pub demucs_model: String,
    #[serde(default)]
    pub demucs_mode: String,
    #[serde(default)]
    pub device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelRegistry {
    pub models: Vec<ModelEntry>,
}

impl ModelRegistry {
    pub fn from_json_str(json: &str) -> Result<Self> {
        let models: Vec<ModelEntry> = serde_json::from_str(json)?;
        Ok(Self { models })
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_json_str(&fs::read_to_string(path)?)
    }

    pub fn save(&self, path: impl AsRef<Path>) -> Result<()> {
        fs::write(path, serde_json::to_string_pretty(&self.models)?)?;
        Ok(())
    }

    pub fn append_missing_from(&mut self, bundled: &Self) -> bool {
        let mut known_ids = self
            .models
            .iter()
            .map(|model| model.id.clone())
            .collect::<HashSet<_>>();
        let mut changed = false;

        for model in &bundled.models {
            if known_ids.insert(model.id.clone()) {
                self.models.push(model.clone());
                changed = true;
            }
        }

        changed
    }

    pub fn installed_for_task(&self, task: &TaskType) -> Vec<ModelEntry> {
        self.models
            .iter()
            .filter(|model| {
                model.installed && model.tasks.iter().any(|candidate| candidate == task)
            })
            .cloned()
            .collect()
    }

    pub fn find(&self, model_id: &str) -> Option<ModelEntry> {
        self.models
            .iter()
            .find(|model| model.id == model_id)
            .cloned()
    }

    pub fn default_for_task(&self, task: &TaskType) -> Option<ModelEntry> {
        let installed = self.installed_for_task(task);
        installed
            .iter()
            .find(|model| model.backend != BackendKind::Stub)
            .cloned()
            .or_else(|| installed.into_iter().next())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_registry() {
        let json = r#"[
          {
            "id": "stub",
            "displayName": "Stub",
            "backend": "stub",
            "tasks": ["vocals_instrumental"],
            "stems": ["Vocals", "Instrumental"],
            "sampleRate": 44100,
            "quality": "development",
            "version": "0.1.0",
            "installed": true,
            "path": ""
          }
        ]"#;

        let registry = ModelRegistry::from_json_str(json).expect("registry should parse");

        assert_eq!(registry.models.len(), 1);
        assert_eq!(registry.models[0].tasks, vec![TaskType::VocalsInstrumental]);
    }

    #[test]
    fn rejects_missing_required_fields() {
        let json = r#"[{"id":"stub"}]"#;
        assert!(ModelRegistry::from_json_str(json).is_err());
    }

    #[test]
    fn append_missing_keeps_existing_entries_and_adds_new_models() {
        let mut local = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "stub",
                "displayName": "Local Stub",
                "backend": "stub",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "development",
                "version": "local",
                "installed": true,
                "path": ""
              }
            ]"#,
        )
        .expect("local registry");
        let bundled = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "stub",
                "displayName": "Bundled Stub",
                "backend": "stub",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "development",
                "version": "bundled",
                "installed": true,
                "path": ""
              },
              {
                "id": "demucs",
                "displayName": "Demucs",
                "backend": "pytorch-worker",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "balanced",
                "version": "4.0.1",
                "installed": true,
                "path": "workers/demucs_worker.py"
              }
            ]"#,
        )
        .expect("bundled registry");

        assert!(local.append_missing_from(&bundled));
        assert_eq!(local.models.len(), 2);
        assert_eq!(local.find("stub").expect("stub").display_name, "Local Stub");
        assert!(local.find("demucs").is_some());
    }
}
