use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
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
}
