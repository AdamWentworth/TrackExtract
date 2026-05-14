use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const BUNDLED_MODELS: &str = include_str!("../../resources/models.json");
const BUNDLED_WORKFLOWS: &str = include_str!("../../resources/workflows.json");

type RunningChildren = HashMap<String, Arc<Mutex<Child>>>;

struct RuntimeState {
    bridge: PythonEngineBridge,
    running_children: Mutex<RunningChildren>,
    media_server: MediaServer,
}

impl RuntimeState {
    fn new(app: &AppHandle) -> Result<Self, String> {
        Ok(Self {
            bridge: PythonEngineBridge::new(app)?,
            running_children: Mutex::new(HashMap::new()),
            media_server: MediaServer::start().map_err(|error| error.to_string())?,
        })
    }
}

fn lock_children(runtime: &RuntimeState) -> Result<MutexGuard<'_, RunningChildren>, String> {
    runtime
        .running_children
        .lock()
        .map_err(|_| "Track Extract child process state is unavailable".to_string())
}

#[derive(Debug, Clone)]
struct PythonEngineBridge {
    python: PathBuf,
    repo_root: PathBuf,
    app_data_dir: PathBuf,
    project_root: PathBuf,
}

impl PythonEngineBridge {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let repo_root = find_repo_root()?;
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        migrate_legacy_app_data(&app_data_dir)?;
        let project_root = default_project_root()?;
        let python = resolve_engine_python(&repo_root);

        Ok(Self {
            python,
            repo_root,
            app_data_dir,
            project_root,
        })
    }

    fn request_payload(&self, args: Value) -> Value {
        json!({
            "context": {
                "appDataDir": self.app_data_dir,
                "projectRoot": self.project_root,
                "repoRoot": self.repo_root,
                "bundledModels": BUNDLED_MODELS,
                "bundledWorkflows": BUNDLED_WORKFLOWS,
            },
            "args": args,
        })
    }

    fn command(&self, command: &str) -> Command {
        let mut process = Command::new(&self.python);
        process
            .arg("-m")
            .arg("trackextract_engine")
            .arg(command)
            .current_dir(&self.repo_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        process
    }

    fn run_json(&self, command: &str, args: Value) -> Result<Value, String> {
        let mut child = self
            .command(command)
            .spawn()
            .map_err(|error| format!("Could not start Track Extract Python engine: {error}"))?;
        write_child_stdin(&mut child, &self.request_payload(args))?;
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(if stderr.is_empty() { stdout } else { stderr });
        }

        serde_json::from_slice(&output.stdout).map_err(|error| {
            format!(
                "Python engine returned invalid JSON for {command}: {error}. Output: {}",
                String::from_utf8_lossy(&output.stdout)
            )
        })
    }

    fn run_jsonl(
        &self,
        command: &str,
        args: Value,
        app: &AppHandle,
        runtime: &Arc<RuntimeState>,
        running_key: Option<String>,
    ) -> Result<Value, String> {
        let mut process = self.command(command);
        process.arg("--jsonl");
        configure_long_running_process(&mut process);
        let mut child = process
            .spawn()
            .map_err(|error| format!("Could not start Track Extract Python engine: {error}"))?;
        write_child_stdin(&mut child, &self.request_payload(args))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Python engine stdout is unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Python engine stderr is unavailable".to_string())?;
        let child = Arc::new(Mutex::new(child));

        if let Some(key) = &running_key {
            lock_children(runtime)?.insert(key.clone(), child.clone());
        }

        let stderr_reader = thread::spawn(move || {
            let mut text = String::new();
            let mut reader = BufReader::new(stderr);
            let _ = reader.read_to_string(&mut text);
            text
        });

        let mut result = None;
        for line in BufReader::new(stdout).lines() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let envelope: Value = serde_json::from_str(&line)
                .map_err(|error| format!("Python engine emitted invalid JSONL: {error}: {line}"))?;
            match envelope.get("type").and_then(Value::as_str) {
                Some("event") => {
                    let name = envelope
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Python event envelope is missing a name".to_string())?;
                    let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
                    app.emit(name, payload).map_err(|error| error.to_string())?;
                }
                Some("result") => {
                    result = Some(envelope.get("payload").cloned().unwrap_or(Value::Null));
                }
                Some("error") => {
                    if let Some(key) = &running_key {
                        let _ = lock_children(runtime).map(|mut children| children.remove(key));
                    }
                    return Err(envelope
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Python engine command failed")
                        .to_string());
                }
                _ => return Err(format!("Python engine emitted an unknown envelope: {line}")),
            }
        }

        let status = child
            .lock()
            .map_err(|_| "Python engine process is unavailable".to_string())?
            .wait()
            .map_err(|error| error.to_string())?;

        if let Some(key) = &running_key {
            lock_children(runtime)?.remove(key);
        }

        let stderr = stderr_reader.join().unwrap_or_default();
        if !status.success() {
            return Err(if stderr.trim().is_empty() {
                format!("Python engine exited with {status}")
            } else {
                stderr.trim().to_string()
            });
        }

        result.ok_or_else(|| "Python engine did not return a result".to_string())
    }
}

fn write_child_stdin(child: &mut Child, payload: &Value) -> Result<(), String> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Python engine stdin is unavailable".to_string())?;
    stdin
        .write_all(
            serde_json::to_string(payload)
                .map_err(|error| error.to_string())?
                .as_bytes(),
        )
        .map_err(|error| error.to_string())
}

fn configure_long_running_process(process: &mut Command) {
    #[cfg(unix)]
    {
        process.process_group(0);
    }
}

fn terminate_child_process(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(format!("-{}", child.id()))
            .status();
        thread::sleep(Duration::from_millis(250));
    }

    let _ = child.kill();
}

#[tauri::command]
fn bootstrap_app(state: State<'_, Arc<RuntimeState>>) -> Result<Value, String> {
    state.bridge.run_json("bootstrap_app", json!({}))
}

#[tauri::command]
fn list_models(state: State<'_, Arc<RuntimeState>>) -> Result<Value, String> {
    state.bridge.run_json("list_models", json!({}))
}

#[tauri::command]
fn list_workflows(state: State<'_, Arc<RuntimeState>>) -> Result<Value, String> {
    state.bridge.run_json("list_workflows", json!({}))
}

#[tauri::command]
fn save_custom_workflow(
    workflow: Value,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    let workflow = state
        .bridge
        .run_json("save_custom_workflow", json!({ "workflow": workflow }))?;
    let workflows = state.bridge.run_json("list_workflows", json!({}))?;
    app.emit("workflows_updated", workflows)
        .map_err(|error| error.to_string())?;
    Ok(workflow)
}

#[tauri::command]
fn import_audio_files(
    paths: Vec<String>,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    let project = state
        .bridge
        .run_json("import_audio_files", json!({ "paths": paths }))?;
    app.emit("project_updated", &project)
        .map_err(|error| error.to_string())?;
    Ok(project)
}

#[tauri::command]
fn enqueue_separation(
    task: String,
    model_id: Option<String>,
    source_id: Option<String>,
    options: Option<Value>,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    let job = state.bridge.run_json(
        "enqueue_separation",
        json!({
            "task": task,
            "modelId": model_id,
            "sourceId": source_id,
            "options": options.unwrap_or_else(|| json!({})),
        }),
    )?;
    app.emit("job_state_changed", &job)
        .map_err(|error| error.to_string())?;
    Ok(job)
}

#[tauri::command]
async fn start_job(
    job_id: String,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    let runtime = state.inner().clone();
    let bridge = runtime.bridge.clone();
    let app_for_job = app.clone();
    let job_id_for_job = job_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        bridge.run_jsonl(
            "start_job",
            json!({ "jobId": job_id_for_job }),
            &app_for_job,
            &runtime,
            Some(job_id),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn install_model(
    model_id: String,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    let runtime = state.inner().clone();
    let bridge = runtime.bridge.clone();
    let app_for_install = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        bridge.run_jsonl(
            "install_model",
            json!({ "modelId": model_id }),
            &app_for_install,
            &runtime,
            None,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_job(
    job_id: String,
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    if let Some(child) = lock_children(&state)?.remove(&job_id) {
        if let Ok(mut child) = child.lock() {
            terminate_child_process(&mut child);
        }
    }
    let job = state
        .bridge
        .run_json("cancel_job", json!({ "jobId": job_id }))?;
    app.emit("job_state_changed", &job)
        .map_err(|error| error.to_string())?;
    Ok(job)
}

#[tauri::command]
fn sync_audio_separator_catalog(
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    let models = state
        .bridge
        .run_json("sync_audio_separator_catalog", json!({}))?;
    app.emit("models_updated", &models)
        .map_err(|error| error.to_string())?;
    app.emit("log_entry", "Synced audio-separator catalog")
        .map_err(|error| error.to_string())?;
    Ok(models)
}

#[tauri::command]
fn get_project(state: State<'_, Arc<RuntimeState>>) -> Result<Value, String> {
    state.bridge.run_json("get_project", json!({}))
}

#[tauri::command]
fn get_jobs(state: State<'_, Arc<RuntimeState>>) -> Result<Value, String> {
    state.bridge.run_json("get_jobs", json!({}))
}

#[tauri::command]
fn clear_jobs(state: State<'_, Arc<RuntimeState>>, app: AppHandle) -> Result<Value, String> {
    let jobs = state.bridge.run_json("clear_jobs", json!({}))?;
    let project = state.bridge.run_json("get_project", json!({}))?;
    app.emit("jobs_updated", &jobs)
        .map_err(|error| error.to_string())?;
    app.emit("project_updated", project)
        .map_err(|error| error.to_string())?;
    app.emit("log_entry", "Cleared job history")
        .map_err(|error| error.to_string())?;
    Ok(jobs)
}

#[tauri::command]
fn export_stems(
    stem_ids: Vec<String>,
    destination_path: String,
    state: State<'_, Arc<RuntimeState>>,
) -> Result<Vec<String>, String> {
    let value = state.bridge.run_json(
        "export_stems",
        json!({ "stemIds": stem_ids, "destinationPath": destination_path }),
    )?;
    serde_json::from_value(value).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_project_stems(
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    let project = state.bridge.run_json("clear_project_stems", json!({}))?;
    app.emit("project_updated", &project)
        .map_err(|error| error.to_string())?;
    app.emit("log_entry", "Cleared generated stems")
        .map_err(|error| error.to_string())?;
    Ok(project)
}

#[tauri::command]
fn clear_project_source(
    state: State<'_, Arc<RuntimeState>>,
    app: AppHandle,
) -> Result<Value, String> {
    let project = state.bridge.run_json("clear_project_source", json!({}))?;
    let jobs = state.bridge.run_json("get_jobs", json!({}))?;
    app.emit("project_updated", &project)
        .map_err(|error| error.to_string())?;
    app.emit("jobs_updated", jobs)
        .map_err(|error| error.to_string())?;
    app.emit("log_entry", "Cleared source audio and dependent stems")
        .map_err(|error| error.to_string())?;
    Ok(project)
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

fn resolve_engine_python(repo_root: &Path) -> PathBuf {
    if let Ok(path) = env::var("TRACKEXTRACT_ENGINE_PYTHON") {
        return PathBuf::from(path);
    }

    for relative in [
        ".venv-trackextract-engine/bin/python",
        ".venv-trackextract-engine/Scripts/python.exe",
    ] {
        let candidate = repo_root.join(relative);
        if candidate.exists() {
            return candidate;
        }
    }

    PathBuf::from("python3")
}

fn find_repo_root() -> Result<PathBuf, String> {
    if let Ok(root) = env::var("TRACKEXTRACT_REPO_ROOT") {
        return Ok(PathBuf::from(root));
    }

    let mut candidates = Vec::new();
    if let Ok(current) = env::current_dir() {
        candidates.push(current);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }

    for candidate in candidates {
        for ancestor in candidate.ancestors() {
            if ancestor.join("engine/src/__main__.py").is_file()
                && ancestor.join("engine/pyproject.toml").is_file()
                && ancestor.join("resources/models.json").is_file()
            {
                return Ok(ancestor.to_path_buf());
            }
        }
    }

    Err("Could not find the Track Extract repo root. Set TRACKEXTRACT_REPO_ROOT.".to_string())
}

fn default_project_root() -> Result<PathBuf, String> {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "Could not find a home directory".to_string())?;
    let music = home.join("Music");
    let documents = home.join("Documents");
    let base = if music.exists() { music } else { documents };
    Ok(base.join("TrackExtract Projects"))
}

fn migrate_legacy_app_data(target: &Path) -> Result<(), String> {
    if target.join("state.json").is_file() || target.join("models.json").is_file() {
        return Ok(());
    }

    for legacy in legacy_app_data_dirs() {
        if legacy == target || !legacy.is_dir() {
            continue;
        }
        if !legacy.join("state.json").is_file() && !legacy.join("models.json").is_file() {
            continue;
        }
        copy_dir_all(&legacy, target).map_err(|error| {
            format!(
                "Could not migrate existing Track Extract app data from {}: {error}",
                legacy.display()
            )
        })?;
        return Ok(());
    }

    Ok(())
}

fn legacy_app_data_dirs() -> Vec<PathBuf> {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .ok();
    let mut paths = Vec::new();

    if let Some(home) = &home {
        paths.push(home.join(".local").join("share").join("trackextract"));
    }

    paths
}

fn copy_dir_all(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let next_target = target.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &next_target)?;
        } else if file_type.is_file() && !next_target.exists() {
            fs::copy(entry.path(), next_target)?;
        }
    }

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
        return Err("Requested media path is outside Track Extract project stems".to_string());
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
    tauri::Builder::default()
        .setup(|app| {
            let runtime = RuntimeState::new(app.handle())?;
            app.manage(Arc::new(runtime));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            bootstrap_app,
            import_audio_files,
            list_models,
            list_workflows,
            save_custom_workflow,
            install_model,
            enqueue_separation,
            start_job,
            cancel_job,
            sync_audio_separator_catalog,
            get_project,
            get_jobs,
            clear_jobs,
            export_stems,
            clear_project_stems,
            clear_project_source,
            stem_media_url,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encoding_roundtrips_paths() {
        let value = "/tmp/TrackExtract Projects/Song/stems/Song - Vocals.wav";
        assert_eq!(
            percent_decode(&percent_encode(value)).expect("decode"),
            value
        );
    }

    #[test]
    fn python_resolution_prefers_env() {
        env::set_var("TRACKEXTRACT_ENGINE_PYTHON", "/custom/python");
        assert_eq!(
            resolve_engine_python(Path::new("/tmp")),
            PathBuf::from("/custom/python")
        );
        env::remove_var("TRACKEXTRACT_ENGINE_PYTHON");
    }

    #[test]
    fn byte_range_parses_open_ended_range() {
        assert_eq!(parse_byte_range("bytes=10-", 100).expect("range"), (10, 99));
    }
}
