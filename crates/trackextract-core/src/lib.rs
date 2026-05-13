pub mod audio;
pub mod backend;
pub mod engine;
pub mod error;
pub mod job;
pub mod model_installer;
pub mod model_registry;
pub mod project;
pub mod workflow_registry;

pub use backend::{
    BackendProgress, PythonWorkerBackend, SeparationBackend, SeparationOutput, SeparationRequest,
    StubSeparationBackend,
};
pub use engine::{BootstrapState, Engine};
pub use error::{Result, TrackExtractError};
pub use job::{JobRecord, JobState};
pub use model_installer::{download_model_file, ModelDownloadProgress, ModelInstallRequest};
pub use model_registry::{BackendKind, ModelEntry, ModelRegistry, ModelRuntimeConfig, TaskType};
pub use project::{AudioSource, ProjectSession, StemFile};
pub use workflow_registry::{WorkflowEntry, WorkflowKind, WorkflowRegistry, WorkflowStep};
