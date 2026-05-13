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
    VocalCleanupChain,
    LayeredVocalCleanup,
    VocalDereverb,
    VocalDenoise,
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
            Self::VocalCleanupChain => "Clean Lead Vocal",
            Self::LayeredVocalCleanup => "Remove Layered Vocals",
            Self::VocalDereverb => "Dereverb Vocal",
            Self::VocalDenoise => "Denoise Vocal",
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
    pub source_url: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub download_size_mb: Option<u32>,
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

    pub fn sync_with_bundled(&mut self, bundled: &Self) -> bool {
        let before_count = self.models.len();
        self.models
            .retain(|model| !DEPRECATED_BUNDLED_MODEL_IDS.contains(&model.id.as_str()));

        let mut known_ids = self
            .models
            .iter()
            .map(|model| model.id.clone())
            .collect::<HashSet<_>>();
        let mut changed = self.models.len() != before_count;

        for model in &bundled.models {
            if DEPRECATED_BUNDLED_MODEL_IDS.contains(&model.id.as_str()) {
                continue;
            }

            if let Some(existing) = self
                .models
                .iter_mut()
                .find(|existing| existing.id == model.id)
            {
                if existing != model {
                    *existing = model.clone();
                    changed = true;
                }
            } else if known_ids.insert(model.id.clone()) {
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

const DEPRECATED_BUNDLED_MODEL_IDS: &[&str] = &[
    "stub_full_stem_split",
    "stub_vocals_instrumental",
    "onnx_roformer_full_split_placeholder",
    "onnx_mdx_vocals_placeholder",
    "pytorch_demucs_experimental_placeholder",
];

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
    fn sync_keeps_user_entries_updates_bundled_entries_and_removes_deprecated_models() {
        let mut local = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "stub_vocals_instrumental",
                "displayName": "Local Stub",
                "backend": "stub",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "development",
                "version": "local",
                "installed": true,
                "path": ""
              },
              {
                "id": "user_custom_model",
                "displayName": "User Model",
                "backend": "external-process",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "custom",
                "version": "local",
                "installed": true,
                "path": "/models/user"
              }
            ]"#,
        )
        .expect("local registry");
        let bundled = ModelRegistry::from_json_str(
            r#"[
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

        assert!(local.sync_with_bundled(&bundled));
        assert_eq!(local.models.len(), 2);
        assert!(local.find("stub_vocals_instrumental").is_none());
        assert_eq!(
            local
                .find("user_custom_model")
                .expect("user model")
                .display_name,
            "User Model"
        );
        assert!(local.find("demucs").is_some());
    }

    #[test]
    fn installed_for_task_filters_by_task_and_install_state() {
        let registry = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "installed",
                "displayName": "Installed",
                "backend": "onnx",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "balanced",
                "version": "1",
                "installed": true,
                "path": "models/onnx/a.onnx"
              },
              {
                "id": "missing",
                "displayName": "Missing",
                "backend": "onnx",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "balanced",
                "version": "1",
                "installed": false,
                "path": "models/onnx/b.onnx"
              },
              {
                "id": "other-task",
                "displayName": "Other Task",
                "backend": "onnx",
                "tasks": ["vocal_denoise"],
                "stems": ["Clean Vocal", "Noise"],
                "sampleRate": 44100,
                "quality": "balanced",
                "version": "1",
                "installed": true,
                "path": "models/onnx/c.onnx"
              }
            ]"#,
        )
        .expect("registry");

        let models = registry.installed_for_task(&TaskType::VocalsInstrumental);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "installed");
    }

    #[test]
    fn default_for_task_prefers_non_stub_models() {
        let registry = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "stub",
                "displayName": "Stub",
                "backend": "stub",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "development",
                "version": "1",
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
                "version": "1",
                "installed": true,
                "path": "workers/demucs_worker.py"
              }
            ]"#,
        )
        .expect("registry");

        let model = registry
            .default_for_task(&TaskType::VocalsInstrumental)
            .expect("default");

        assert_eq!(model.id, "demucs");
    }

    #[test]
    fn default_for_task_falls_back_to_stub_when_it_is_the_only_installed_model() {
        let registry = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "stub",
                "displayName": "Stub",
                "backend": "stub",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "development",
                "version": "1",
                "installed": true,
                "path": ""
              }
            ]"#,
        )
        .expect("registry");

        let model = registry
            .default_for_task(&TaskType::VocalsInstrumental)
            .expect("default");

        assert_eq!(model.id, "stub");
    }

    #[test]
    fn find_returns_none_for_unknown_model_id() {
        let registry = ModelRegistry::from_json_str("[]").expect("registry");

        assert!(registry.find("missing").is_none());
    }

    #[test]
    fn sync_updates_existing_bundled_entries() {
        let mut local = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "demucs",
                "displayName": "Old Name",
                "backend": "pytorch-worker",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "balanced",
                "version": "old",
                "installed": true,
                "path": "workers/demucs_worker.py"
              }
            ]"#,
        )
        .expect("local");
        let bundled = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "demucs",
                "displayName": "New Name",
                "backend": "pytorch-worker",
                "tasks": ["vocals_instrumental"],
                "stems": ["Vocals", "Instrumental"],
                "sampleRate": 44100,
                "quality": "best",
                "version": "new",
                "installed": true,
                "path": "workers/demucs_worker.py"
              }
            ]"#,
        )
        .expect("bundled");

        assert!(local.sync_with_bundled(&bundled));
        let model = local.find("demucs").expect("model");
        assert_eq!(model.display_name, "New Name");
        assert_eq!(model.quality, "best");
    }

    #[test]
    fn parses_vocal_cleanup_task_types() {
        let registry = ModelRegistry::from_json_str(
            r#"[
              {
                "id": "cleanup",
                "displayName": "Cleanup",
                "backend": "onnx",
                "tasks": ["vocal_cleanup_chain", "layered_vocal_cleanup", "vocal_dereverb", "vocal_denoise"],
                "stems": ["Clean Vocal", "Noise"],
                "sampleRate": 44100,
                "quality": "best",
                "version": "1",
                "installed": false,
                "path": "models/onnx/cleanup.onnx"
              }
            ]"#,
        )
        .expect("registry");

        assert_eq!(
            registry.models[0].tasks,
            vec![
                TaskType::VocalCleanupChain,
                TaskType::LayeredVocalCleanup,
                TaskType::VocalDereverb,
                TaskType::VocalDenoise
            ]
        );
    }
}
