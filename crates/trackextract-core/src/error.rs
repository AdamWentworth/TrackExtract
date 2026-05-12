use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum TrackExtractError {
    #[error("Audio decode failed: {0}")]
    Audio(String),

    #[error("Job was cancelled")]
    Cancelled,

    #[error("File not found: {0}")]
    FileNotFound(PathBuf),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Model not available: {0}")]
    ModelUnavailable(String),

    #[error("No project is currently open")]
    NoProject,

    #[error("Project has no imported audio files")]
    NoSourceAudio,

    #[error("Job not found: {0}")]
    JobNotFound(String),

    #[error("{0}")]
    UserFacing(String),

    #[error("WAV writer error: {0}")]
    Wav(#[from] hound::Error),
}

pub type Result<T> = std::result::Result<T, TrackExtractError>;
