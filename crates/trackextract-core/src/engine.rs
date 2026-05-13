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
    model_registry::{ModelEntry, ModelRegistry, TaskType},
    project::ProjectSession,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub project_root: PathBuf,
    pub app_data_dir: PathBuf,
    pub model_registry_path: PathBuf,
    pub models: Vec<ModelEntry>,
    pub current_project: Option<ProjectSession>,
    pub jobs: Vec<JobRecord>,
}

#[derive(Debug)]
pub struct Engine {
    project_root: PathBuf,
    app_data_dir: PathBuf,
    model_registry_path: PathBuf,
    registry: ModelRegistry,
    current_project: Option<ProjectSession>,
    jobs: Vec<JobRecord>,
}

impl Engine {
    pub fn bootstrap(bundled_model_registry: &str) -> Result<Self> {
        let app_data_dir = default_app_data_dir()?;
        let project_root = default_project_root()?;

        Self::bootstrap_with_paths(bundled_model_registry, app_data_dir, project_root)
    }

    pub fn bootstrap_with_paths(
        bundled_model_registry: &str,
        app_data_dir: PathBuf,
        project_root: PathBuf,
    ) -> Result<Self> {
        fs::create_dir_all(&app_data_dir)?;

        let model_registry_path = app_data_dir.join("models.json");
        let bundled_registry = ModelRegistry::from_json_str(bundled_model_registry)?;
        if !model_registry_path.exists() {
            fs::write(&model_registry_path, bundled_model_registry)?;
        }

        let mut registry = ModelRegistry::load(&model_registry_path)?;
        if registry.sync_with_bundled(&bundled_registry) {
            registry.save(&model_registry_path)?;
        }
        fs::create_dir_all(&project_root)?;
        let current_project = load_latest_project_session(&project_root);

        Ok(Self {
            project_root,
            app_data_dir,
            model_registry_path,
            registry,
            current_project,
            jobs: Vec::new(),
        })
    }

    pub fn snapshot(&self) -> BootstrapState {
        BootstrapState {
            project_root: self.project_root.clone(),
            app_data_dir: self.app_data_dir.clone(),
            model_registry_path: self.model_registry_path.clone(),
            models: self.registry.models.clone(),
            current_project: self.current_project.clone(),
            jobs: self.jobs.clone(),
        }
    }

    pub fn list_models(&self) -> Vec<ModelEntry> {
        self.registry.models.clone()
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

        let job = JobRecord::new(project, &source, task, model.id.clone());
        project.add_job(&job.id)?;
        self.jobs.push(job.clone());
        Ok(job)
    }

    pub fn prepare_job(&mut self, job_id: &str) -> Result<(JobRecord, SeparationRequest)> {
        let project = self
            .current_project
            .as_ref()
            .ok_or(TrackExtractError::NoProject)?;
        let job = self
            .jobs
            .iter_mut()
            .find(|job| job.id == job_id)
            .ok_or_else(|| TrackExtractError::JobNotFound(job_id.to_string()))?;
        let model = self
            .registry
            .find(&job.model_id)
            .ok_or_else(|| TrackExtractError::ModelUnavailable(job.model_id.clone()))?;

        job.set_state(JobState::Preparing, "Preparing source audio");
        job.progress = 0.0;
        job.error = None;

        let request = SeparationRequest {
            job_id: job.id.clone(),
            project_name: project.name.clone(),
            source_path: job.source_path.clone(),
            stems_dir: project.stems_dir(),
            logs_dir: project.logs_dir(),
            model,
            task: job.task.clone(),
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
