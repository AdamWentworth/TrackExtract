use std::{
    collections::{HashMap, HashSet},
    env,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
};

use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};
use trackextract_core::{
    download_model_file, BackendKind, BackendProgress, BootstrapState, Engine, JobRecord,
    ModelDownloadProgress, ModelEntry, ProjectSession, PythonWorkerBackend, SeparationBackend,
    StubSeparationBackend, TaskType, TrackExtractError,
};

const BUNDLED_MODELS: &str = include_str!("../../resources/models.json");

struct RuntimeState {
    engine: Mutex<Engine>,
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    model_installs: Mutex<HashSet<String>>,
    media_server: MediaServer,
}

impl RuntimeState {
    fn new() -> trackextract_core::Result<Self> {
        let media_server = MediaServer::start()?;

        Ok(Self {
            engine: Mutex::new(Engine::bootstrap(BUNDLED_MODELS)?),
            cancellations: Mutex::new(HashMap::new()),
            model_installs: Mutex::new(HashSet::new()),
            media_server,
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

fn lock_model_installs(runtime: &RuntimeState) -> Result<MutexGuard<'_, HashSet<String>>, String> {
    runtime
        .model_installs
        .lock()
        .map_err(|_| "TrackExtract model installer state is unavailable".to_string())
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
async fn install_model(
    model_id: String,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<ModelEntry, String> {
    let runtime = state.inner().clone();
    {
        let mut installs = lock_model_installs(&runtime)?;
        if !installs.insert(model_id.clone()) {
            return Err("That model is already installing".to_string());
        }
    }

    let result = install_model_inner(model_id.clone(), runtime.clone(), app).await;
    if let Ok(mut installs) = lock_model_installs(&runtime) {
        installs.remove(&model_id);
    }
    result
}

async fn install_model_inner(
    model_id: String,
    runtime: Arc<RuntimeState>,
    app: AppHandle,
) -> Result<ModelEntry, String> {
    let request = {
        let engine = lock_engine(&runtime)?;
        engine
            .prepare_model_install(&model_id)
            .map_err(command_error)?
    };

    let runtime_for_install = runtime.clone();
    let app_for_install = app.clone();
    let model_id_for_install = model_id.clone();
    let destination = tauri::async_runtime::spawn_blocking(move || {
        let progress_handler = |progress: ModelDownloadProgress| {
            let _ = app_for_install.emit("model_download_progress", &progress);
        };

        download_model_file(request, &progress_handler, Arc::new(AtomicBool::new(false)))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(command_error)?;

    let (model, models) = {
        let mut engine = lock_engine(&runtime_for_install)?;
        let model = engine
            .complete_model_install(&model_id_for_install)
            .map_err(command_error)?;
        let models = engine.list_models();
        (model, models)
    };

    app.emit("models_updated", &models)
        .map_err(|error| error.to_string())?;
    app.emit(
        "log_entry",
        format!(
            "Installed {} at {}",
            model.display_name,
            destination.display()
        ),
    )
    .map_err(|error| error.to_string())?;

    Ok(model)
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
    options: Option<serde_json::Value>,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<JobRecord, String> {
    let job = lock_engine(&state)?
        .enqueue_separation(task, model_id, source_id, options)
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
fn stem_media_url(path: String, state: State<'_, Arc<RuntimeState>>) -> Result<String, String> {
    Ok(state.media_server.url_for_path(&PathBuf::from(path)))
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

#[derive(Debug)]
struct MediaServer {
    origin: String,
}

impl MediaServer {
    fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let origin = format!("http://{}", listener.local_addr()?);

        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                thread::spawn(move || {
                    let _ = handle_media_stream(stream);
                });
            }
        });

        Ok(Self { origin })
    }

    fn url_for_path(&self, path: &Path) -> String {
        format!(
            "{}/stem?path={}",
            self.origin,
            percent_encode(&path.to_string_lossy())
        )
    }
}

fn handle_media_stream(mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }

        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();

    if method == "OPTIONS" {
        write_response(
            &mut stream,
            "204 No Content",
            &[("Access-Control-Allow-Origin", "*".to_string())],
            &[],
        )?;
        return Ok(());
    }

    if method != "GET" && method != "HEAD" {
        write_error_response(&mut stream, "405 Method Not Allowed", "Method not allowed")?;
        return Ok(());
    }

    match stream_stem_http(
        &mut stream,
        target,
        headers.get("range").map(String::as_str),
        method == "HEAD",
    ) {
        Ok(()) => Ok(()),
        Err(error) => write_error_response(&mut stream, "400 Bad Request", &error),
    }
}

fn stream_stem_http(
    stream: &mut TcpStream,
    target: &str,
    range: Option<&str>,
    head_only: bool,
) -> Result<(), String> {
    let path = media_target_path(target)?;
    let canonical_path = path.canonicalize().map_err(|error| error.to_string())?;

    if !is_trackextract_stem_path(&canonical_path) {
        return Err("Requested media path is outside TrackExtract project stems".to_string());
    }

    let mut file = File::open(&canonical_path).map_err(|error| error.to_string())?;
    let len = file
        .seek(SeekFrom::End(0))
        .map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;

    if let Some(range) = range {
        let (start, end) = parse_byte_range(range, len)?;
        let bytes_to_read = end + 1 - start;
        write_headers(
            stream,
            "206 Partial Content",
            &[
                ("Content-Type", "audio/wav".to_string()),
                ("Accept-Ranges", "bytes".to_string()),
                ("Content-Length", bytes_to_read.to_string()),
                ("Content-Range", format!("bytes {start}-{end}/{len}")),
                ("Access-Control-Allow-Origin", "*".to_string()),
                ("Connection", "close".to_string()),
            ],
        )
        .map_err(|error| error.to_string())?;

        if !head_only {
            file.seek(SeekFrom::Start(start))
                .map_err(|error| error.to_string())?;
            std::io::copy(&mut file.take(bytes_to_read), stream)
                .map_err(|error| error.to_string())?;
        }
    } else {
        write_headers(
            stream,
            "200 OK",
            &[
                ("Content-Type", "audio/wav".to_string()),
                ("Accept-Ranges", "bytes".to_string()),
                ("Content-Length", len.to_string()),
                ("Access-Control-Allow-Origin", "*".to_string()),
                ("Connection", "close".to_string()),
            ],
        )
        .map_err(|error| error.to_string())?;

        if !head_only {
            std::io::copy(&mut file, stream).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn media_target_path(target: &str) -> Result<PathBuf, String> {
    let (path, query) = target
        .split_once('?')
        .ok_or_else(|| "Media request is missing a path query".to_string())?;
    if path != "/stem" {
        return Err("Media request path is not supported".to_string());
    }

    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "path" {
            return Ok(PathBuf::from(percent_decode(value)?));
        }
    }

    Err("Media request is missing a stem path".to_string())
}

fn write_error_response(
    stream: &mut TcpStream,
    status: &str,
    message: &str,
) -> std::io::Result<()> {
    write_response(
        stream,
        status,
        &[
            ("Content-Type", "text/plain".to_string()),
            ("Access-Control-Allow-Origin", "*".to_string()),
            ("Connection", "close".to_string()),
        ],
        message.as_bytes(),
    )
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut headers = headers.to_vec();
    headers.push(("Content-Length", body.len().to_string()));
    write_headers(stream, status, &headers)?;
    stream.write_all(body)
}

fn write_headers(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\n")?;
    for (key, value) in headers {
        write!(stream, "{key}: {value}\r\n")?;
    }
    write!(stream, "\r\n")
}

fn is_trackextract_stem_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"))
        && path
            .components()
            .any(|component| component.as_os_str() == "TrackExtract Projects")
        && path
            .parent()
            .and_then(|parent| parent.file_name())
            .is_some_and(|name| name == "stems")
}

fn parse_byte_range(range: &str, len: u64) -> Result<(u64, u64), String> {
    let range = range
        .strip_prefix("bytes=")
        .ok_or_else(|| "Only byte ranges are supported".to_string())?;
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| "Byte range is malformed".to_string())?;

    if len == 0 {
        return Err("Cannot range-read an empty file".to_string());
    }

    let (start, end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .map_err(|_| "Byte range suffix is malformed".to_string())?;
        let start = len.saturating_sub(suffix);
        (start, len - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| "Byte range start is malformed".to_string())?;
        let end = if end.is_empty() {
            len - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| "Byte range end is malformed".to_string())?
        };
        (start, end.min(len - 1))
    };

    if start > end || start >= len {
        Err("Byte range is not satisfiable".to_string())
    } else {
        Ok((start, end))
    }
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes
                .get(index + 1)
                .and_then(|byte| hex_value(*byte))
                .ok_or_else(|| "Percent-encoded path is malformed".to_string())?;
            let low = bytes
                .get(index + 2)
                .and_then(|byte| hex_value(*byte))
                .ok_or_else(|| "Percent-encoded path is malformed".to_string())?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(output).map_err(|_| "Media path is not valid UTF-8".to_string())
}

fn percent_encode(input: &str) -> String {
    let mut output = String::with_capacity(input.len());

    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char);
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }

    output
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
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
            install_model,
            enqueue_separation,
            start_job,
            cancel_job,
            get_project,
            get_jobs,
            export_stems,
            stem_media_url,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
