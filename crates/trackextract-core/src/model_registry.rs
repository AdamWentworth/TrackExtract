use std::{fs, path::Path};

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
        self.installed_for_task(task).into_iter().next()
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
}
