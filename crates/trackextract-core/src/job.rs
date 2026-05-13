use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    model_registry::TaskType,
    project::{AudioSource, ProjectSession, StemFile},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Preparing,
    Running,
    Complete,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub source_id: String,
    pub source_path: PathBuf,
    pub task: TaskType,
    pub model_id: String,
    pub options: Value,
    pub state: JobState,
    pub progress: f32,
    pub status_message: String,
    pub error: Option<String>,
    pub stems: Vec<StemFile>,
    pub log_path: Option<PathBuf>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobRecord {
    pub fn new(
        project: &ProjectSession,
        source: &AudioSource,
        task: TaskType,
        model_id: String,
        options: Value,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            source_id: source.id.clone(),
            source_path: source.project_path.clone(),
            task,
            model_id,
            options,
            state: JobState::Queued,
            progress: 0.0,
            status_message: "Queued".to_string(),
            error: None,
            stems: Vec::new(),
            log_path: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn set_state(&mut self, state: JobState, message: impl Into<String>) {
        self.state = state;
        self.status_message = message.into();
        self.updated_at = Utc::now();
    }

    pub fn set_progress(&mut self, progress: f32, message: impl Into<String>) {
        self.progress = progress.clamp(0.0, 1.0);
        self.status_message = message.into();
        self.updated_at = Utc::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_state_transitions_are_recorded() {
        let mut job = JobRecord {
            id: "job".into(),
            project_id: "project".into(),
            project_name: "Project".into(),
            source_id: "source".into(),
            source_path: PathBuf::from("source.wav"),
            task: TaskType::VocalsInstrumental,
            model_id: "stub".into(),
            options: serde_json::json!({}),
            state: JobState::Queued,
            progress: 0.0,
            status_message: "Queued".into(),
            error: None,
            stems: Vec::new(),
            log_path: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        job.set_state(JobState::Preparing, "Preparing");
        assert_eq!(job.state, JobState::Preparing);
        job.set_state(JobState::Running, "Running");
        assert_eq!(job.state, JobState::Running);
        job.set_state(JobState::Complete, "Complete");
        assert_eq!(job.state, JobState::Complete);
        job.set_state(JobState::Failed, "Failed");
        assert_eq!(job.state, JobState::Failed);
        job.set_state(JobState::Cancelled, "Cancelled");
        assert_eq!(job.state, JobState::Cancelled);
    }

    #[test]
    fn progress_is_clamped_to_valid_range() {
        let mut job = test_job();

        job.set_progress(-0.5, "too low");
        assert_eq!(job.progress, 0.0);
        assert_eq!(job.status_message, "too low");

        job.set_progress(1.5, "too high");
        assert_eq!(job.progress, 1.0);
        assert_eq!(job.status_message, "too high");
    }

    #[test]
    fn set_state_updates_message_and_timestamp() {
        let mut job = test_job();
        let previous_updated_at = job.updated_at;

        job.set_state(JobState::Running, "Rendering");

        assert_eq!(job.state, JobState::Running);
        assert_eq!(job.status_message, "Rendering");
        assert!(job.updated_at >= previous_updated_at);
    }

    #[test]
    fn new_job_copies_project_and_source_identity() {
        let project = ProjectSession {
            schema_version: 1,
            id: "project-id".into(),
            name: "Project Name".into(),
            root_path: PathBuf::from("/tmp/project"),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            original_files: Vec::new(),
            jobs: Vec::new(),
            stems: Vec::new(),
        };
        let source = AudioSource {
            id: "source-id".into(),
            original_name: "song.wav".into(),
            source_path: PathBuf::from("/imports/song.wav"),
            project_path: PathBuf::from("/tmp/project/original/song.wav"),
            sample_rate: Some(44_100),
            channels: Some(2),
            duration_seconds: Some(123.0),
        };

        let job = JobRecord::new(
            &project,
            &source,
            TaskType::VocalCleanupChain,
            "model-id".into(),
            serde_json::json!({
                "device": "cpu"
            }),
        );

        assert_eq!(job.project_id, "project-id");
        assert_eq!(job.project_name, "Project Name");
        assert_eq!(job.source_id, "source-id");
        assert_eq!(job.source_path, source.project_path);
        assert_eq!(job.task, TaskType::VocalCleanupChain);
        assert_eq!(job.model_id, "model-id");
        assert_eq!(job.options["device"], "cpu");
        assert_eq!(job.state, JobState::Queued);
        assert_eq!(job.progress, 0.0);
    }

    fn test_job() -> JobRecord {
        JobRecord {
            id: "job".into(),
            project_id: "project".into(),
            project_name: "Project".into(),
            source_id: "source".into(),
            source_path: PathBuf::from("source.wav"),
            task: TaskType::VocalsInstrumental,
            model_id: "stub".into(),
            options: serde_json::json!({}),
            state: JobState::Queued,
            progress: 0.0,
            status_message: "Queued".into(),
            error: None,
            stems: Vec::new(),
            log_path: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}
