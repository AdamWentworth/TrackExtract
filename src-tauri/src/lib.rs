use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};
use trackextract_core::{
    BackendKind, BackendProgress, BootstrapState, Engine, JobRecord, ModelEntry, ProjectSession,
    PythonWorkerBackend, SeparationBackend, StubSeparationBackend, TaskType, TrackExtractError,
};

const BUNDLED_MODELS: &str = include_str!("../../resources/models.json");

struct RuntimeState {
    engine: Mutex<Engine>,
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl RuntimeState {
    fn new() -> trackextract_core::Result<Self> {
        Ok(Self {
            engine: Mutex::new(Engine::bootstrap(BUNDLED_MODELS)?),
            cancellations: Mutex::new(HashMap::new()),
        })
    }
}

fn lock_engine(runtime: &RuntimeState) -> Result<MutexGuard<'_, Engine>, String> {
    runtime
        .engine
        .lock()
        .map_err(|_| "TrackExtract engine state is unavailable".to_string())
}

fn lock_cancellations(
    runtime: &RuntimeState,
) -> Result<MutexGuard<'_, HashMap<String, Arc<AtomicBool>>>, String> {
    runtime
        .cancellations
        .lock()
        .map_err(|_| "TrackExtract cancellation state is unavailable".to_string())
}

fn command_error(error: TrackExtractError) -> String {
    error.to_string()
}

#[tauri::command]
fn bootstrap_app(state: State<'_, Arc<RuntimeState>>) -> Result<BootstrapState, String> {
    Ok(lock_engine(&state)?.snapshot())
}

#[tauri::command]
fn list_models(state: State<'_, Arc<RuntimeState>>) -> Result<Vec<ModelEntry>, String> {
    Ok(lock_engine(&state)?.list_models())
}

#[tauri::command]
fn import_audio_files(
    paths: Vec<String>,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<ProjectSession, String> {
    let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    let project = lock_engine(&state)?
        .import_audio_files(paths)
        .map_err(command_error)?;

    app.emit("project_updated", &project)
        .map_err(|error| error.to_string())?;
    Ok(project)
}

#[tauri::command]
fn enqueue_separation(
    task: TaskType,
    model_id: Option<String>,
    source_id: Option<String>,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<JobRecord, String> {
    let job = lock_engine(&state)?
        .enqueue_separation(task, model_id, source_id)
        .map_err(command_error)?;

    app.emit("job_state_changed", &job)
        .map_err(|error| error.to_string())?;
    Ok(job)
}

#[tauri::command]
async fn start_job(
    job_id: String,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<JobRecord, String> {
    let runtime = state.inner().clone();
    let cancel_token = Arc::new(AtomicBool::new(false));

    {
        lock_cancellations(&runtime)?.insert(job_id.clone(), cancel_token.clone());
    }

    let request = {
        let mut engine = lock_engine(&runtime)?;
        let (job, request) = engine.prepare_job(&job_id).map_err(command_error)?;
        app.emit("job_state_changed", &job)
            .map_err(|error| error.to_string())?;

        let running_job = engine.mark_job_running(&job_id).map_err(command_error)?;
        app.emit("job_state_changed", &running_job)
            .map_err(|error| error.to_string())?;
        request
    };

    let runtime_for_job = runtime.clone();
    let app_for_job = app.clone();
    let job_id_for_job = job_id.clone();
    let backend_result = tauri::async_runtime::spawn_blocking(move || {
        let progress_handler = |progress: BackendProgress| {
            let updated_job = lock_engine(&runtime_for_job).and_then(|mut engine| {
                engine
                    .update_job_progress(
                        &progress.job_id,
                        progress.progress,
                        progress.message.clone(),
                    )
                    .map_err(command_error)
            });

            if let Ok(job) = updated_job {
                let _ = app_for_job.emit("job_progress", &progress);
                let _ = app_for_job.emit("job_state_changed", &job);
            }
        };

        match request.model.backend.clone() {
            BackendKind::Stub => {
                let backend = StubSeparationBackend;
                backend.run(request, &progress_handler, cancel_token)
            }
            BackendKind::PytorchWorker => {
                let backend = PythonWorkerBackend;
                backend.run(request, &progress_handler, cancel_token)
            }
            BackendKind::Onnx => Err(TrackExtractError::ModelUnavailable(
                "ONNX Runtime backend is not implemented in this prototype yet".to_string(),
            )),
            BackendKind::ExternalProcess => Err(TrackExtractError::ModelUnavailable(
                "External process backend is not implemented in this prototype yet".to_string(),
            )),
        }
    })
    .await
    .map_err(|error| error.to_string())?;

    lock_cancellations(&runtime)?.remove(&job_id_for_job);

    let final_job = {
        let mut engine = lock_engine(&runtime)?;
        match backend_result {
            Ok(output) => {
                let job = engine
                    .complete_job(&job_id_for_job, output)
                    .map_err(command_error)?;
                if let Some(project) = engine.current_project() {
                    app.emit("project_updated", &project)
                        .map_err(|error| error.to_string())?;
                }
                job
            }
            Err(TrackExtractError::Cancelled) => {
                engine.cancel_job(&job_id_for_job).map_err(command_error)?
            }
            Err(error) => engine
                .fail_job(&job_id_for_job, error.to_string())
                .map_err(command_error)?,
        }
    };

    app.emit("job_state_changed", &final_job)
        .map_err(|error| error.to_string())?;
    Ok(final_job)
}

#[tauri::command]
fn cancel_job(
    job_id: String,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<JobRecord, String> {
    if let Some(token) = lock_cancellations(&state)?.get(&job_id) {
        token.store(true, Ordering::Relaxed);
    }

    let job = lock_engine(&state)?
        .cancel_job(&job_id)
        .map_err(command_error)?;
    app.emit("job_state_changed", &job)
        .map_err(|error| error.to_string())?;
    Ok(job)
}

#[tauri::command]
fn get_project(state: State<'_, Arc<RuntimeState>>) -> Result<Option<ProjectSession>, String> {
    Ok(lock_engine(&state)?.current_project())
}

#[tauri::command]
fn get_jobs(state: State<'_, Arc<RuntimeState>>) -> Result<Vec<JobRecord>, String> {
    Ok(lock_engine(&state)?.jobs())
}

#[tauri::command]
fn export_stems(
    stem_ids: Vec<String>,
    destination_path: String,
    state: State<'_, Arc<RuntimeState>>,
) -> Result<Vec<String>, String> {
    let exported = lock_engine(&state)?
        .export_stems(&stem_ids, &PathBuf::from(destination_path))
        .map_err(command_error)?;

    Ok(exported
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    open_path(&PathBuf::from(path))
}

fn open_path(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = RuntimeState::new().expect("failed to initialize TrackExtract runtime");

    tauri::Builder::default()
        .manage(Arc::new(runtime))
        .setup(|app| {
            if let Ok(worker_path) = app
                .path()
                .resolve("demucs_worker.py", BaseDirectory::Resource)
            {
                if worker_path.exists() {
                    env::set_var("TRACKEXTRACT_DEMUCS_WORKER", worker_path);
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            bootstrap_app,
            import_audio_files,
            list_models,
            enqueue_separation,
            start_job,
            cancel_job,
            get_project,
            get_jobs,
            export_stems,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
