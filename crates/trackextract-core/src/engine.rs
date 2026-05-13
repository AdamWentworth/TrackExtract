use std::{
    fs,
    path::{Path, PathBuf},
};

use directories::{BaseDirs, ProjectDirs, UserDirs};
use serde::{Deserialize, Serialize};

use crate::{
    backend::{SeparationOutput, SeparationRequest},
    error::{Result, TrackExtractError},
    job::{JobRecord, JobState},
    model_installer::ModelInstallRequest,
    model_registry::{resolve_model_options, ModelEntry, ModelRegistry, TaskType},
    project::ProjectSession,
    workflow_registry::{WorkflowEntry, WorkflowKind, WorkflowRegistry},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub project_root: PathBuf,
    pub app_data_dir: PathBuf,
    pub model_registry_path: PathBuf,
    pub workflow_registry_path: PathBuf,
    pub models: Vec<ModelEntry>,
    pub workflows: Vec<WorkflowEntry>,
    pub current_project: Option<ProjectSession>,
    pub jobs: Vec<JobRecord>,
}

#[derive(Debug)]
pub struct Engine {
    project_root: PathBuf,
    app_data_dir: PathBuf,
    model_registry_path: PathBuf,
    workflow_registry_path: PathBuf,
    registry: ModelRegistry,
    workflow_registry: WorkflowRegistry,
    current_project: Option<ProjectSession>,
    jobs: Vec<JobRecord>,
}

impl Engine {
    pub fn bootstrap(
        bundled_model_registry: &str,
        bundled_workflow_registry: &str,
    ) -> Result<Self> {
        let app_data_dir = default_app_data_dir()?;
        let project_root = default_project_root()?;

        Self::bootstrap_with_paths(
            bundled_model_registry,
            bundled_workflow_registry,
            app_data_dir,
            project_root,
        )
    }

    pub fn bootstrap_with_paths(
        bundled_model_registry: &str,
        bundled_workflow_registry: &str,
        app_data_dir: PathBuf,
        project_root: PathBuf,
    ) -> Result<Self> {
        fs::create_dir_all(&app_data_dir)?;

        let model_registry_path = app_data_dir.join("models.json");
        let workflow_registry_path = app_data_dir.join("workflows.json");
        let bundled_registry = ModelRegistry::from_json_str(bundled_model_registry)?;
        let bundled_workflows = WorkflowRegistry::from_json_str(bundled_workflow_registry)?;
        if !model_registry_path.exists() {
            fs::write(&model_registry_path, bundled_model_registry)?;
        }
        if !workflow_registry_path.exists() {
            fs::write(&workflow_registry_path, bundled_workflow_registry)?;
        }

        let mut registry = ModelRegistry::load(&model_registry_path)?;
        if registry.sync_with_bundled(&bundled_registry) {
            registry.save(&model_registry_path)?;
        }
        let mut workflow_registry = WorkflowRegistry::load(&workflow_registry_path)?;
        if workflow_registry.sync_with_bundled(&bundled_workflows) {
            workflow_registry.save(&workflow_registry_path)?;
        }
        let mut registry_changed = false;
        refresh_managed_download_status(&mut registry.models, &app_data_dir, &mut registry_changed);
        if registry_changed {
            registry.save(&model_registry_path)?;
        }
        fs::create_dir_all(&project_root)?;
        let current_project = load_latest_project_session(&project_root);

        Ok(Self {
            project_root,
            app_data_dir,
            model_registry_path,
            workflow_registry_path,
            registry,
            workflow_registry,
            current_project,
            jobs: Vec::new(),
        })
    }

    pub fn snapshot(&self) -> BootstrapState {
        BootstrapState {
            project_root: self.project_root.clone(),
            app_data_dir: self.app_data_dir.clone(),
            model_registry_path: self.model_registry_path.clone(),
            workflow_registry_path: self.workflow_registry_path.clone(),
            models: self.registry.models.clone(),
            workflows: self.workflow_registry.workflows.clone(),
            current_project: self.current_project.clone(),
            jobs: self.jobs.clone(),
        }
    }

    pub fn list_models(&self) -> Vec<ModelEntry> {
        self.registry.models.clone()
    }

    pub fn list_workflows(&self) -> Vec<WorkflowEntry> {
        self.workflow_registry.workflows.clone()
    }

    pub fn save_custom_workflow(&mut self, workflow: WorkflowEntry) -> Result<WorkflowEntry> {
        if workflow.kind != WorkflowKind::Custom && workflow.kind != WorkflowKind::Template {
            return Err(TrackExtractError::UserFacing(
                "Only custom workflows can be saved from the app".to_string(),
            ));
        }

        if workflow.id.trim().is_empty()
            || workflow.display_name.trim().is_empty()
            || workflow.steps.is_empty()
        {
            return Err(TrackExtractError::UserFacing(
                "Workflow name and at least one step are required".to_string(),
            ));
        }

        for step in &workflow.steps {
            let model = self
                .registry
                .find(&step.model_id)
                .ok_or_else(|| TrackExtractError::ModelUnavailable(step.model_id.clone()))?;
            if !model.tasks.iter().any(|task| task == &step.task) {
                return Err(TrackExtractError::ModelUnavailable(format!(
                    "{} does not support {}",
                    model.display_name,
                    step.task.display_name()
                )));
            }
        }

        let id = workflow.id.clone();
        self.workflow_registry.upsert_custom(workflow);
        self.workflow_registry.save(&self.workflow_registry_path)?;
        self.workflow_registry.find(&id).ok_or_else(|| {
            TrackExtractError::UserFacing("Saved workflow could not be reloaded".to_string())
        })
    }

    pub fn prepare_model_install(&self, model_id: &str) -> Result<ModelInstallRequest> {
        let model = self
            .registry
            .find(model_id)
            .ok_or_else(|| TrackExtractError::ModelUnavailable(model_id.to_string()))?;

        if model.download_url.trim().is_empty() {
            return Err(TrackExtractError::ModelUnavailable(format!(
                "{} does not have a managed download yet",
                model.display_name
            )));
        }

        let destination_path = self.managed_model_path(&model).ok_or_else(|| {
            TrackExtractError::ModelUnavailable(format!(
                "{} does not have a managed local install path yet",
                model.display_name
            ))
        })?;
        let temp_path = destination_path.with_extension(format!(
            "{}download",
            destination_path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| format!("{extension}."))
                .unwrap_or_default()
        ));

        Ok(ModelInstallRequest {
            model_id: model.id,
            display_name: model.display_name,
            download_url: model.download_url,
            destination_path,
            temp_path,
            expected_size_mb: model.download_size_mb,
        })
    }

    pub fn complete_model_install(&mut self, model_id: &str) -> Result<ModelEntry> {
        let model = self
            .registry
            .models
            .iter_mut()
            .find(|model| model.id == model_id)
            .ok_or_else(|| TrackExtractError::ModelUnavailable(model_id.to_string()))?;
        model.installed = true;
        let model = model.clone();
        self.registry.save(&self.model_registry_path)?;
        Ok(model)
    }

    pub fn current_project(&self) -> Option<ProjectSession> {
        self.current_project.clone()
    }

    pub fn jobs(&self) -> Vec<JobRecord> {
        self.jobs.clone()
    }

    pub fn import_audio_files(&mut self, paths: Vec<PathBuf>) -> Result<ProjectSession> {
        let session = ProjectSession::create(&self.project_root, &paths)?;
        self.current_project = Some(session.clone());
        self.jobs.clear();
        Ok(session)
    }

    pub fn enqueue_separation(
        &mut self,
        task: TaskType,
        model_id: Option<String>,
        source_id: Option<String>,
        options: Option<serde_json::Value>,
    ) -> Result<JobRecord> {
        let project = self
            .current_project
            .as_mut()
            .ok_or(TrackExtractError::NoProject)?;
        let source = match source_id {
            Some(source_id) => project
                .original_files
                .iter()
                .find(|source| source.id == source_id)
                .cloned()
                .ok_or_else(|| {
                    TrackExtractError::UserFacing("Imported audio file was not found".to_string())
                })?,
            None => project
                .original_files
                .first()
                .cloned()
                .ok_or(TrackExtractError::NoSourceAudio)?,
        };
        let model = match model_id {
            Some(model_id) => self
                .registry
                .find(&model_id)
                .ok_or_else(|| TrackExtractError::ModelUnavailable(model_id))?,
            None => self.registry.default_for_task(&task).ok_or_else(|| {
                TrackExtractError::ModelUnavailable(task.display_name().to_string())
            })?,
        };

        if !model.installed {
            return Err(TrackExtractError::ModelUnavailable(format!(
                "{} is not installed yet",
                model.display_name
            )));
        }

        if !model.tasks.iter().any(|candidate| candidate == &task) {
            return Err(TrackExtractError::ModelUnavailable(format!(
                "{} does not support {}",
                model.display_name,
                task.display_name()
            )));
        }

        let resolved_options = resolve_model_options(&model, options)?;
        let job = JobRecord::new(project, &source, task, model.id.clone(), resolved_options);
        project.add_job(&job.id)?;
        self.jobs.push(job.clone());
        Ok(job)
    }

    pub fn prepare_job(&mut self, job_id: &str) -> Result<(JobRecord, SeparationRequest)> {
        let project = self
            .current_project
            .as_ref()
            .ok_or(TrackExtractError::NoProject)?;
        let job_index = self
            .jobs
            .iter()
            .position(|job| job.id == job_id)
            .ok_or_else(|| TrackExtractError::JobNotFound(job_id.to_string()))?;
        let model_id = self.jobs[job_index].model_id.clone();
        let model = self
            .registry
            .find(&model_id)
            .ok_or_else(|| TrackExtractError::ModelUnavailable(model_id.clone()))?;
        let model_path = self.local_model_path(&model);
        let job = &mut self.jobs[job_index];

        job.set_state(JobState::Preparing, "Preparing source audio");
        job.progress = 0.0;
        job.error = None;

        let request = SeparationRequest {
            job_id: job.id.clone(),
            project_name: project.name.clone(),
            source_path: job.source_path.clone(),
            stems_dir: project.stems_dir(),
            logs_dir: project.logs_dir(),
            app_data_dir: self.app_data_dir.clone(),
            model_path,
            model,
            task: job.task.clone(),
            options: job.options.clone(),
        };

        Ok((job.clone(), request))
    }

    pub fn mark_job_running(&mut self, job_id: &str) -> Result<JobRecord> {
        let job = self.job_mut(job_id)?;
        job.set_state(JobState::Running, "Running separation");
        Ok(job.clone())
    }

    pub fn update_job_progress(
        &mut self,
        job_id: &str,
        progress: f32,
        message: impl Into<String>,
    ) -> Result<JobRecord> {
        let job = self.job_mut(job_id)?;
        job.set_progress(progress, message);
        Ok(job.clone())
    }

    pub fn complete_job(&mut self, job_id: &str, output: SeparationOutput) -> Result<JobRecord> {
        let stems = output.stems;
        if let Some(project) = self.current_project.as_mut() {
            project.replace_job_stems(job_id, stems.clone())?;
        }

        let job = self.job_mut(job_id)?;
        job.stems = stems;
        job.log_path = Some(output.log_path);
        job.progress = 1.0;
        job.error = None;
        job.set_state(JobState::Complete, "Complete");
        Ok(job.clone())
    }

    pub fn fail_job(&mut self, job_id: &str, error: impl Into<String>) -> Result<JobRecord> {
        let error = error.into();
        let job = self.job_mut(job_id)?;
        job.error = Some(error.clone());
        job.set_state(JobState::Failed, error);
        Ok(job.clone())
    }

    pub fn cancel_job(&mut self, job_id: &str) -> Result<JobRecord> {
        let job = self.job_mut(job_id)?;
        job.set_state(JobState::Cancelled, "Cancelled");
        Ok(job.clone())
    }

    pub fn export_stems(&self, stem_ids: &[String], destination: &Path) -> Result<Vec<PathBuf>> {
        let project = self
            .current_project
            .as_ref()
            .ok_or(TrackExtractError::NoProject)?;
        fs::create_dir_all(destination)?;

        let selected = if stem_ids.is_empty() {
            project.stems.clone()
        } else {
            project
                .stems
                .iter()
                .filter(|stem| stem_ids.iter().any(|id| id == &stem.id))
                .cloned()
                .collect()
        };

        let mut exported = Vec::with_capacity(selected.len());
        for stem in selected {
            let file_name = stem.path.file_name().ok_or_else(|| {
                TrackExtractError::UserFacing("Stem file has no filename".to_string())
            })?;
            let output = destination.join(file_name);
            fs::copy(&stem.path, &output)?;
            exported.push(output);
        }

        Ok(exported)
    }

    fn job_mut(&mut self, job_id: &str) -> Result<&mut JobRecord> {
        self.jobs
            .iter_mut()
            .find(|job| job.id == job_id)
            .ok_or_else(|| TrackExtractError::JobNotFound(job_id.to_string()))
    }

    fn managed_model_path(&self, model: &ModelEntry) -> Option<PathBuf> {
        managed_model_path(&self.app_data_dir, model)
    }

    fn local_model_path(&self, model: &ModelEntry) -> Option<PathBuf> {
        self.managed_model_path(model)
            .filter(|path| path.is_file())
            .or_else(|| {
                let path = Path::new(&model.path);
                if path.is_absolute() && path.is_file() {
                    Some(path.to_path_buf())
                } else {
                    None
                }
            })
    }
}

fn refresh_managed_download_status(
    models: &mut [ModelEntry],
    app_data_dir: &Path,
    changed: &mut bool,
) {
    for model in models {
        let Some(path) = managed_model_path(app_data_dir, model) else {
            continue;
        };
        let installed = path.is_file();
        if model.installed != installed {
            model.installed = installed;
            *changed = true;
        }
    }
}

fn managed_model_path(app_data_dir: &Path, model: &ModelEntry) -> Option<PathBuf> {
    let path = Path::new(&model.path);
    if !is_managed_download_path(path) {
        return None;
    }

    Some(app_data_dir.join(path))
}

fn is_managed_download_path(path: &Path) -> bool {
    !path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
        && path.starts_with("models")
}

fn default_project_root() -> Result<PathBuf> {
    let base = UserDirs::new()
        .and_then(|dirs| dirs.audio_dir().map(Path::to_path_buf))
        .or_else(|| UserDirs::new().and_then(|dirs| dirs.document_dir().map(Path::to_path_buf)))
        .or_else(|| BaseDirs::new().map(|dirs| dirs.home_dir().join("Documents")))
        .ok_or_else(|| {
            TrackExtractError::UserFacing("Could not find a home directory".to_string())
        })?;

    Ok(base.join("TrackExtract Projects"))
}

fn default_app_data_dir() -> Result<PathBuf> {
    ProjectDirs::from("com", "Phlosion", "TrackExtract")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .or_else(|| BaseDirs::new().map(|dirs| dirs.home_dir().join(".trackextract")))
        .ok_or_else(|| {
            TrackExtractError::UserFacing("Could not find an app data directory".to_string())
        })
}

fn load_latest_project_session(project_root: &Path) -> Option<ProjectSession> {
    fs::read_dir(project_root)
        .ok()?
        .filter_map(|entry| {
            let path = entry.ok()?.path().join("session.json");
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .and_then(|(_, path)| ProjectSession::load(&path).ok())
}

#[cfg(test)]
mod tests {
    use std::thread;

    use crate::{
        backend::SeparationOutput,
        project::{StemFile, SESSION_SCHEMA_VERSION},
    };

    use super::*;

    const TEST_MODELS: &str = r#"[
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
      },
      {
        "id": "onnx_download",
        "displayName": "ONNX Download",
        "backend": "onnx",
        "tasks": ["vocals_instrumental"],
        "stems": ["Vocals", "Instrumental"],
        "sampleRate": 44100,
        "quality": "fast",
        "version": "1",
        "installed": false,
        "path": "models/onnx/download.onnx",
        "downloadUrl": "https://example.com/download.onnx",
        "downloadSizeMb": 1
      },
      {
        "id": "source_only",
        "displayName": "Source Only",
        "backend": "external-process",
        "tasks": ["vocal_cleanup_chain"],
        "stems": ["Vocals", "Instrumental"],
        "sampleRate": 44100,
        "quality": "best",
        "version": "1",
        "installed": false,
        "path": "",
        "downloadUrl": "https://example.com/catalog"
      }
    ]"#;

    const TEST_WORKFLOWS: &str = r#"[
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
    ]"#;

    fn write_test_wav(path: &Path) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44_100,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav writer");
        for index in 0..256 {
            writer
                .write_sample((index as f32 / 256.0) * 0.25)
                .expect("sample");
        }
        writer.finalize().expect("finalize");
    }

    fn engine_in_temp(temp: &tempfile::TempDir) -> Engine {
        Engine::bootstrap_with_paths(
            TEST_MODELS,
            TEST_WORKFLOWS,
            temp.path().join("app-data"),
            temp.path().join("projects"),
        )
        .expect("engine")
    }

    #[test]
    fn bootstrap_copies_bundled_registry_to_app_data() {
        let temp = tempfile::tempdir().expect("tempdir");

        let engine = engine_in_temp(&temp);
        let snapshot = engine.snapshot();

        assert!(snapshot.model_registry_path.is_file());
        assert!(snapshot.workflow_registry_path.is_file());
        assert_eq!(snapshot.models.len(), 3);
        assert_eq!(snapshot.workflows.len(), 1);
    }

    #[test]
    fn bootstrap_marks_managed_model_installed_when_file_exists() {
        let temp = tempfile::tempdir().expect("tempdir");
        let model_path = temp
            .path()
            .join("app-data")
            .join("models/onnx/download.onnx");
        fs::create_dir_all(model_path.parent().unwrap()).expect("model dir");
        fs::write(&model_path, b"model").expect("model file");

        let engine = engine_in_temp(&temp);
        let model = engine
            .list_models()
            .into_iter()
            .find(|model| model.id == "onnx_download")
            .expect("model");

        assert!(model.installed);
    }

    #[test]
    fn bootstrap_marks_managed_model_missing_when_file_is_absent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let app_data = temp.path().join("app-data");
        fs::create_dir_all(&app_data).expect("app data");
        fs::write(
            app_data.join("models.json"),
            TEST_MODELS.replace("\"installed\": false", "\"installed\": true"),
        )
        .expect("local registry");

        let engine = Engine::bootstrap_with_paths(
            TEST_MODELS,
            TEST_WORKFLOWS,
            app_data,
            temp.path().join("projects"),
        )
        .expect("engine");
        let model = engine
            .list_models()
            .into_iter()
            .find(|model| model.id == "onnx_download")
            .expect("model");

        assert!(!model.installed);
    }

    #[test]
    fn prepare_model_install_resolves_app_data_destination_and_temp_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let engine = engine_in_temp(&temp);

        let request = engine
            .prepare_model_install("onnx_download")
            .expect("install request");

        assert_eq!(request.model_id, "onnx_download");
        assert!(request
            .destination_path
            .ends_with("models/onnx/download.onnx"));
        assert!(request
            .destination_path
            .starts_with(temp.path().join("app-data")));
        assert!(request
            .temp_path
            .ends_with("models/onnx/download.onnx.download"));
        assert_eq!(request.expected_size_mb, Some(1));
    }

    #[test]
    fn prepare_model_install_rejects_catalog_only_entries() {
        let temp = tempfile::tempdir().expect("tempdir");
        let engine = engine_in_temp(&temp);

        let error = engine
            .prepare_model_install("source_only")
            .expect_err("source-only entry");

        assert!(matches!(error, TrackExtractError::ModelUnavailable(_)));
    }

    #[test]
    fn complete_model_install_sets_installed_and_persists_registry() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut engine = engine_in_temp(&temp);

        let model = engine
            .complete_model_install("onnx_download")
            .expect("complete install");
        let reloaded = ModelRegistry::load(temp.path().join("app-data/models.json"))
            .expect("registry")
            .find("onnx_download")
            .expect("model");

        assert!(model.installed);
        assert!(reloaded.installed);
    }

    #[test]
    fn import_audio_creates_project_and_clears_existing_jobs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("song.wav");
        write_test_wav(&source);
        let mut engine = engine_in_temp(&temp);
        engine
            .import_audio_files(vec![source.clone()])
            .expect("first import");
        engine
            .enqueue_separation(
                TaskType::VocalsInstrumental,
                Some("demucs".into()),
                None,
                None,
            )
            .expect("enqueue");

        let project = engine
            .import_audio_files(vec![source])
            .expect("second import");

        assert_eq!(project.original_files.len(), 1);
        assert!(engine.jobs().is_empty());
    }

    #[test]
    fn enqueue_requires_a_current_project() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut engine = engine_in_temp(&temp);

        let error = engine
            .enqueue_separation(
                TaskType::VocalsInstrumental,
                Some("demucs".into()),
                None,
                None,
            )
            .expect_err("no project");

        assert!(matches!(error, TrackExtractError::NoProject));
    }

    #[test]
    fn enqueue_rejects_missing_or_unsupported_models() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("song.wav");
        write_test_wav(&source);
        let mut engine = engine_in_temp(&temp);
        engine.import_audio_files(vec![source]).expect("import");

        let missing = engine
            .enqueue_separation(
                TaskType::VocalsInstrumental,
                Some("missing".into()),
                None,
                None,
            )
            .expect_err("missing model");
        let unsupported = engine
            .enqueue_separation(TaskType::VocalDenoise, Some("demucs".into()), None, None)
            .expect_err("unsupported task");

        assert!(matches!(missing, TrackExtractError::ModelUnavailable(_)));
        assert!(matches!(
            unsupported,
            TrackExtractError::ModelUnavailable(_)
        ));
    }

    #[test]
    fn prepare_running_progress_fail_and_cancel_update_jobs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("song.wav");
        write_test_wav(&source);
        let mut engine = engine_in_temp(&temp);
        engine.import_audio_files(vec![source]).expect("import");
        let job = engine
            .enqueue_separation(
                TaskType::VocalsInstrumental,
                Some("demucs".into()),
                None,
                None,
            )
            .expect("enqueue");

        let (prepared, request) = engine.prepare_job(&job.id).expect("prepare");
        assert_eq!(prepared.state, JobState::Preparing);
        assert_eq!(request.model.id, "demucs");

        let running = engine.mark_job_running(&job.id).expect("running");
        assert_eq!(running.state, JobState::Running);

        let progress = engine
            .update_job_progress(&job.id, 0.42, "Working")
            .expect("progress");
        assert_eq!(progress.progress, 0.42);
        assert_eq!(progress.status_message, "Working");

        let failed = engine.fail_job(&job.id, "Nope").expect("fail");
        assert_eq!(failed.state, JobState::Failed);
        assert_eq!(failed.error.as_deref(), Some("Nope"));

        let cancelled = engine.cancel_job(&job.id).expect("cancel");
        assert_eq!(cancelled.state, JobState::Cancelled);
    }

    #[test]
    fn complete_job_updates_project_stems_and_export_selected_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("song.wav");
        write_test_wav(&source);
        let mut engine = engine_in_temp(&temp);
        let project = engine.import_audio_files(vec![source]).expect("import");
        let job = engine
            .enqueue_separation(
                TaskType::VocalsInstrumental,
                Some("demucs".into()),
                None,
                None,
            )
            .expect("enqueue");
        let vocal_path = project.stems_dir().join("Song - Vocals.wav");
        let instrumental_path = project.stems_dir().join("Song - Instrumental.wav");
        fs::write(&vocal_path, b"vocals").expect("vocal file");
        fs::write(&instrumental_path, b"instrumental").expect("instrumental file");
        let stems = vec![
            StemFile::new("Vocals", vocal_path, job.id.clone()),
            StemFile::new("Instrumental", instrumental_path, job.id.clone()),
        ];

        let completed = engine
            .complete_job(
                &job.id,
                SeparationOutput {
                    stems: stems.clone(),
                    log_path: project.logs_dir().join("job.log"),
                },
            )
            .expect("complete");
        let export_dir = temp.path().join("export");
        let exported = engine
            .export_stems(&[stems[0].id.clone()], &export_dir)
            .expect("export");

        assert_eq!(completed.state, JobState::Complete);
        assert_eq!(engine.current_project().unwrap().stems.len(), 2);
        assert_eq!(exported.len(), 1);
        assert!(exported[0].ends_with("Song - Vocals.wav"));
    }

    #[test]
    fn export_without_ids_exports_all_stems() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("song.wav");
        write_test_wav(&source);
        let mut engine = engine_in_temp(&temp);
        let project = engine.import_audio_files(vec![source]).expect("import");
        let job = engine
            .enqueue_separation(
                TaskType::VocalsInstrumental,
                Some("demucs".into()),
                None,
                None,
            )
            .expect("enqueue");
        let vocal_path = project.stems_dir().join("Song - Vocals.wav");
        let instrumental_path = project.stems_dir().join("Song - Instrumental.wav");
        fs::write(&vocal_path, b"vocals").expect("vocal file");
        fs::write(&instrumental_path, b"instrumental").expect("instrumental file");

        engine
            .complete_job(
                &job.id,
                SeparationOutput {
                    stems: vec![
                        StemFile::new("Vocals", vocal_path, job.id.clone()),
                        StemFile::new("Instrumental", instrumental_path, job.id.clone()),
                    ],
                    log_path: project.logs_dir().join("job.log"),
                },
            )
            .expect("complete");
        let exported = engine
            .export_stems(&[], &temp.path().join("export"))
            .expect("export all");

        assert_eq!(exported.len(), 2);
    }

    #[test]
    fn bootstrap_loads_latest_project_session() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source_a = temp.path().join("a.wav");
        let source_b = temp.path().join("b.wav");
        write_test_wav(&source_a);
        write_test_wav(&source_b);
        let projects = temp.path().join("projects");
        let _first = ProjectSession::create(&projects, &[source_a]).expect("first project");
        thread::sleep(std::time::Duration::from_millis(5));
        let second = ProjectSession::create(&projects, &[source_b]).expect("second project");

        let engine = Engine::bootstrap_with_paths(
            TEST_MODELS,
            TEST_WORKFLOWS,
            temp.path().join("app-data"),
            projects,
        )
        .expect("engine");

        assert_eq!(engine.current_project().unwrap().id, second.id);
    }

    #[test]
    fn snapshot_contains_bootstrap_paths_and_schema_models() {
        let temp = tempfile::tempdir().expect("tempdir");
        let engine = engine_in_temp(&temp);

        let snapshot = engine.snapshot();

        assert_eq!(snapshot.project_root, temp.path().join("projects"));
        assert_eq!(snapshot.app_data_dir, temp.path().join("app-data"));
        assert!(snapshot.workflow_registry_path.ends_with("workflows.json"));
        assert!(snapshot
            .models
            .iter()
            .any(|model| model.id == "demucs" && model.sample_rate == 44_100));
        assert!(snapshot
            .workflows
            .iter()
            .any(|workflow| workflow.id == "quick"));
        assert!(snapshot.current_project.is_none());
        assert!(snapshot.jobs.is_empty());
        assert_eq!(SESSION_SCHEMA_VERSION, 1);
    }

    #[test]
    fn saves_custom_workflow_to_app_data_registry() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut engine = engine_in_temp(&temp);
        let workflow = WorkflowEntry {
            id: "custom_vocal".into(),
            display_name: "Custom Vocal".into(),
            description: "User workflow".into(),
            kind: WorkflowKind::Custom,
            task: TaskType::VocalsInstrumental,
            steps: vec![crate::workflow_registry::WorkflowStep {
                id: "split".into(),
                display_name: "Split".into(),
                task: TaskType::VocalsInstrumental,
                model_id: "demucs".into(),
                input_stem: String::new(),
                output_stems: Vec::new(),
                options: serde_json::json!({ "device": "cpu" }),
            }],
        };

        let saved = engine
            .save_custom_workflow(workflow)
            .expect("save workflow");

        assert_eq!(saved.kind, WorkflowKind::Custom);
        assert!(engine
            .list_workflows()
            .iter()
            .any(|workflow| workflow.id == "custom_vocal"));
        assert!(temp.path().join("app-data/workflows.json").is_file());
    }
}
