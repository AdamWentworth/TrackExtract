use std::{
    env,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    audio::{decode_audio_file, write_wav},
    error::{Result, TrackExtractError},
    model_registry::{BackendKind, ModelEntry, TaskType},
    project::{daw_friendly_stem_filename, StemFile},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendProgress {
    pub job_id: String,
    pub progress: f32,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct SeparationRequest {
    pub job_id: String,
    pub project_name: String,
    pub source_path: PathBuf,
    pub stems_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub app_data_dir: PathBuf,
    pub model: ModelEntry,
    pub model_path: Option<PathBuf>,
    pub task: TaskType,
    pub options: Value,
}

#[derive(Debug, Clone)]
pub struct SeparationOutput {
    pub stems: Vec<StemFile>,
    pub log_path: PathBuf,
}

pub trait SeparationBackend: Send + Sync {
    fn kind(&self) -> BackendKind;

    fn run(
        &self,
        request: SeparationRequest,
        progress: &(dyn Fn(BackendProgress) + Send + Sync),
        cancel_token: Arc<AtomicBool>,
    ) -> Result<SeparationOutput>;
}

#[derive(Debug, Default)]
pub struct StubSeparationBackend;

impl StubSeparationBackend {
    fn report(
        request: &SeparationRequest,
        progress: &(dyn Fn(BackendProgress) + Send + Sync),
        amount: f32,
        message: impl Into<String>,
    ) {
        progress(BackendProgress {
            job_id: request.job_id.clone(),
            progress: amount,
            message: message.into(),
        });
    }

    fn check_cancelled(cancel_token: &AtomicBool) -> Result<()> {
        if cancel_token.load(Ordering::Relaxed) {
            Err(TrackExtractError::Cancelled)
        } else {
            Ok(())
        }
    }
}

impl SeparationBackend for StubSeparationBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Stub
    }

    fn run(
        &self,
        request: SeparationRequest,
        progress: &(dyn Fn(BackendProgress) + Send + Sync),
        cancel_token: Arc<AtomicBool>,
    ) -> Result<SeparationOutput> {
        fs::create_dir_all(&request.stems_dir)?;
        fs::create_dir_all(&request.logs_dir)?;

        let log_path = request.logs_dir.join(format!("{}.log", request.job_id));
        let mut log = File::create(&log_path)?;
        writeln!(log, "TrackExtract stub separation job {}", request.job_id)?;
        writeln!(log, "Task: {:?}", request.task)?;
        writeln!(log, "Model: {}", request.model.display_name)?;
        writeln!(log, "Input: {}", request.source_path.display())?;

        Self::report(&request, progress, 0.05, "Preparing source audio");
        thread::sleep(Duration::from_millis(120));
        Self::check_cancelled(&cancel_token)?;

        let decoded = decode_audio_file(&request.source_path)?;
        writeln!(
            log,
            "Decoded {} samples, {} channels, {} Hz",
            decoded.samples.len(),
            decoded.channels,
            decoded.sample_rate
        )?;

        Self::report(&request, progress, 0.18, "Generating placeholder stems");
        thread::sleep(Duration::from_millis(120));
        Self::check_cancelled(&cancel_token)?;

        let stem_count = request.model.stems.len().max(1);
        let mut stems = Vec::with_capacity(stem_count);

        for (index, label) in request.model.stems.iter().enumerate() {
            Self::check_cancelled(&cancel_token)?;

            let path = request
                .stems_dir
                .join(daw_friendly_stem_filename(&request.project_name, label));
            let gain = placeholder_gain(label, index);
            write_wav(&path, &decoded, gain)?;
            writeln!(log, "Wrote {label}: {}", path.display())?;

            stems.push(StemFile::new(label, path, request.job_id.clone()));

            let amount = 0.18 + ((index + 1) as f32 / stem_count as f32) * 0.77;
            Self::report(
                &request,
                progress,
                amount,
                format!("Rendered placeholder {label}"),
            );
            thread::sleep(Duration::from_millis(140));
        }

        Self::report(&request, progress, 1.0, "Stub separation complete");
        writeln!(log, "Complete")?;

        Ok(SeparationOutput { stems, log_path })
    }
}

fn placeholder_gain(label: &str, index: usize) -> f32 {
    match label.to_ascii_lowercase().as_str() {
        "vocals" => 0.72,
        "instrumental" => 0.56,
        "drums" => 0.48,
        "bass" => 0.38,
        "guitar" => 0.44,
        "piano" => 0.42,
        "other" => 0.32,
        _ => 0.28 + (index as f32 % 4.0) * 0.08,
    }
}

#[derive(Debug, Default)]
pub struct PythonWorkerBackend;

impl PythonWorkerBackend {
    fn report(
        request: &SeparationRequest,
        progress: &(dyn Fn(BackendProgress) + Send + Sync),
        amount: f32,
        message: impl Into<String>,
    ) {
        progress(BackendProgress {
            job_id: request.job_id.clone(),
            progress: amount,
            message: message.into(),
        });
    }

    fn resolve_python() -> PathBuf {
        if let Ok(path) = env::var("TRACKEXTRACT_PYTHON") {
            return PathBuf::from(path);
        }

        for root in candidate_roots() {
            for relative in [
                ".venv-demucs/bin/python",
                ".venv-demucs/Scripts/python.exe",
                ".venv/bin/python",
                ".venv/Scripts/python.exe",
            ] {
                let candidate = root.join(relative);
                if candidate.exists() {
                    return candidate;
                }
            }
        }

        PathBuf::from("python3")
    }

    fn resolve_worker_script(request: &SeparationRequest) -> Result<PathBuf> {
        if let Ok(path) = env::var("TRACKEXTRACT_DEMUCS_WORKER") {
            let path = PathBuf::from(path);
            if path.exists() {
                return Ok(path);
            }
        }

        let configured = if !request.model.runtime.worker_script.is_empty() {
            request.model.runtime.worker_script.as_str()
        } else if !request.model.path.is_empty() {
            request.model.path.as_str()
        } else {
            "workers/demucs_worker.py"
        };

        let configured_path = PathBuf::from(configured);
        if configured_path.is_absolute() && configured_path.exists() {
            return Ok(configured_path);
        }

        for root in candidate_roots() {
            let candidate = root.join(&configured_path);
            if candidate.exists() {
                return Ok(candidate);
            }
        }

        Err(TrackExtractError::UserFacing(format!(
            "Demucs worker script was not found at {configured}. Run from the TrackExtract repo or set an absolute worker path in the model registry."
        )))
    }

    fn demucs_model(request: &SeparationRequest) -> String {
        if !request.model.runtime.demucs_model.is_empty() {
            return request.model.runtime.demucs_model.clone();
        }

        match request.task {
            TaskType::FullStemSplit | TaskType::ExperimentalBestQuality => "htdemucs_6s",
            TaskType::VocalCleanupChain
            | TaskType::LayeredVocalCleanup
            | TaskType::VocalDereverb
            | TaskType::VocalDenoise => "htdemucs",
            _ => "htdemucs",
        }
        .to_string()
    }

    fn demucs_mode(request: &SeparationRequest) -> String {
        if !request.model.runtime.demucs_mode.is_empty() {
            return request.model.runtime.demucs_mode.clone();
        }

        match request.task {
            TaskType::VocalsInstrumental => "vocals",
            TaskType::FullStemSplit | TaskType::ExperimentalBestQuality => "full",
            TaskType::DrumsOnly => "drums",
            TaskType::BassOnly => "bass",
            TaskType::GuitarOnly => "guitar",
            TaskType::PianoOnly => "piano",
            TaskType::VocalCleanupChain
            | TaskType::LayeredVocalCleanup
            | TaskType::VocalDereverb
            | TaskType::VocalDenoise => "vocals",
        }
        .to_string()
    }

    fn device(request: &SeparationRequest) -> String {
        env::var("TRACKEXTRACT_DEMUCS_DEVICE")
            .ok()
            .filter(|device| !device.trim().is_empty())
            .unwrap_or_else(|| {
                if let Some(device) = option_string(&request.options, "device") {
                    return device;
                }

                if request.model.runtime.device.is_empty() {
                    "auto".to_string()
                } else {
                    request.model.runtime.device.clone()
                }
            })
    }
}

impl SeparationBackend for PythonWorkerBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::PytorchWorker
    }

    fn run(
        &self,
        request: SeparationRequest,
        progress: &(dyn Fn(BackendProgress) + Send + Sync),
        cancel_token: Arc<AtomicBool>,
    ) -> Result<SeparationOutput> {
        fs::create_dir_all(&request.stems_dir)?;
        fs::create_dir_all(&request.logs_dir)?;

        let python = Self::resolve_python();
        let worker_script = Self::resolve_worker_script(&request)?;
        let log_path = request.logs_dir.join(format!("{}.log", request.job_id));
        let result_path = request
            .logs_dir
            .join(format!("{}.demucs-result.json", request.job_id));
        let work_dir = request
            .logs_dir
            .join(format!("demucs-work-{}", request.job_id));

        Self::report(&request, progress, 0.03, "Preparing Demucs worker");

        let mut command = Command::new(&python);
        command
            .arg(worker_script)
            .arg("--input")
            .arg(&request.source_path)
            .arg("--output-dir")
            .arg(&request.stems_dir)
            .arg("--work-dir")
            .arg(&work_dir)
            .arg("--result-json")
            .arg(&result_path)
            .arg("--log-path")
            .arg(&log_path)
            .arg("--project-name")
            .arg(&request.project_name)
            .arg("--job-id")
            .arg(&request.job_id)
            .arg("--task")
            .arg(task_arg(&request.task))
            .arg("--model")
            .arg(Self::demucs_model(&request))
            .arg("--mode")
            .arg(Self::demucs_mode(&request))
            .arg("--device")
            .arg(Self::device(&request))
            .arg("--shifts")
            .arg(
                option_u64(&request.options, "demucsShifts")
                    .unwrap_or(1)
                    .to_string(),
            )
            .arg("--overlap")
            .arg(
                option_f64(&request.options, "demucsOverlap")
                    .unwrap_or(0.25)
                    .to_string(),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if let Some(segment) =
            option_f64(&request.options, "demucsSegmentSeconds").filter(|segment| *segment > 0.0)
        {
            command.arg("--segment").arg(segment.to_string());
        }

        Self::report(&request, progress, 0.08, "Starting Demucs separation");

        let mut child = command.spawn().map_err(|error| {
            TrackExtractError::UserFacing(format!(
                "Could not start Demucs worker with {}: {error}. Run scripts/setup-demucs-worker.sh or set TRACKEXTRACT_PYTHON.",
                python.display()
            ))
        })?;

        let started = Instant::now();
        let mut last_reported_second = 0;
        let status = loop {
            if cancel_token.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(TrackExtractError::Cancelled);
            }

            if let Some(status) = child.try_wait()? {
                break status;
            }

            let elapsed = started.elapsed().as_secs();
            if elapsed / 2 > last_reported_second {
                last_reported_second = elapsed / 2;
                let progress_amount = (0.12 + (elapsed as f32 / 240.0) * 0.76).min(0.88);
                Self::report(
                    &request,
                    progress,
                    progress_amount,
                    if elapsed < 30 {
                        "Running Demucs model"
                    } else {
                        "Still separating audio with Demucs"
                    },
                );
            }

            thread::sleep(Duration::from_millis(250));
        };

        if !status.success() {
            let detail = read_log_tail(&log_path).unwrap_or_else(|| {
                format!(
                    "Worker exited with status {status}. Check that Demucs is installed in {}.",
                    python.display()
                )
            });
            return Err(TrackExtractError::UserFacing(format!(
                "Demucs separation failed: {detail}"
            )));
        }

        Self::report(&request, progress, 0.94, "Collecting generated stems");

        let result_json = fs::read_to_string(&result_path).map_err(|error| {
            TrackExtractError::UserFacing(format!(
                "Demucs finished but did not write a result file: {error}"
            ))
        })?;
        let worker_result: WorkerResult = serde_json::from_str(&result_json)?;
        let stems = worker_result
            .stems
            .into_iter()
            .map(|stem| StemFile::new(stem.label, PathBuf::from(stem.path), request.job_id.clone()))
            .collect::<Vec<_>>();

        Self::report(&request, progress, 1.0, "Demucs separation complete");

        Ok(SeparationOutput { stems, log_path })
    }
}

#[derive(Debug, Default)]
pub struct AudioSeparatorBackend;

impl AudioSeparatorBackend {
    fn report(
        request: &SeparationRequest,
        progress: &(dyn Fn(BackendProgress) + Send + Sync),
        amount: f32,
        message: impl Into<String>,
    ) {
        progress(BackendProgress {
            job_id: request.job_id.clone(),
            progress: amount,
            message: message.into(),
        });
    }

    fn resolve_python() -> PathBuf {
        if let Ok(path) = env::var("TRACKEXTRACT_AUDIO_SEPARATOR_PYTHON") {
            return PathBuf::from(path);
        }

        if let Ok(path) = env::var("TRACKEXTRACT_PYTHON") {
            return PathBuf::from(path);
        }

        for root in candidate_roots() {
            for relative in [
                ".venv-audio-separator/bin/python",
                ".venv-audio-separator/Scripts/python.exe",
                ".venv/bin/python",
                ".venv/Scripts/python.exe",
            ] {
                let candidate = root.join(relative);
                if candidate.exists() {
                    return candidate;
                }
            }
        }

        PathBuf::from("python3")
    }

    fn resolve_worker_script(request: &SeparationRequest) -> Result<PathBuf> {
        if let Ok(path) = env::var("TRACKEXTRACT_AUDIO_SEPARATOR_WORKER") {
            let path = PathBuf::from(path);
            if path.exists() {
                return Ok(path);
            }
        }

        let configured = if !request.model.runtime.worker_script.is_empty() {
            request.model.runtime.worker_script.as_str()
        } else {
            "workers/audio_separator_worker.py"
        };

        let configured_path = PathBuf::from(configured);
        if configured_path.is_absolute() && configured_path.exists() {
            return Ok(configured_path);
        }

        for root in candidate_roots() {
            let candidate = root.join(&configured_path);
            if candidate.exists() {
                return Ok(candidate);
            }
        }

        Err(TrackExtractError::UserFacing(format!(
            "Audio Separator worker script was not found at {configured}. Run from the TrackExtract repo or set TRACKEXTRACT_AUDIO_SEPARATOR_WORKER."
        )))
    }

    fn model_path(request: &SeparationRequest) -> Result<PathBuf> {
        let model_path = request.model_path.clone().ok_or_else(|| {
            TrackExtractError::ModelUnavailable(format!(
                "{} does not have an installed local model file",
                request.model.display_name
            ))
        })?;

        if !model_path.is_file() {
            return Err(TrackExtractError::ModelUnavailable(format!(
                "{} was expected at {}, but the file is missing",
                request.model.display_name,
                model_path.display()
            )));
        }

        let extension = model_path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension == "th" {
            return Err(TrackExtractError::ModelUnavailable(format!(
                "{} is a raw Demucs weight asset and needs a YAML model definition before it can run",
                request.model.display_name
            )));
        }

        Ok(model_path)
    }

    fn device(request: &SeparationRequest) -> String {
        option_string(&request.options, "device")
            .filter(|device| !device.trim().is_empty())
            .or_else(|| {
                if request.model.runtime.device.is_empty() {
                    None
                } else {
                    Some(request.model.runtime.device.clone())
                }
            })
            .unwrap_or_else(|| "auto".to_string())
    }
}

impl SeparationBackend for AudioSeparatorBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::ExternalProcess
    }

    fn run(
        &self,
        request: SeparationRequest,
        progress: &(dyn Fn(BackendProgress) + Send + Sync),
        cancel_token: Arc<AtomicBool>,
    ) -> Result<SeparationOutput> {
        fs::create_dir_all(&request.stems_dir)?;
        fs::create_dir_all(&request.logs_dir)?;

        let python = Self::resolve_python();
        let worker_script = Self::resolve_worker_script(&request)?;
        let model_path = Self::model_path(&request)?;
        let model_file_dir = model_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| request.app_data_dir.join("models"));
        let model_filename = model_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                TrackExtractError::ModelUnavailable(format!(
                    "{} has an invalid model filename",
                    request.model.display_name
                ))
            })?
            .to_string();

        let log_path = request.logs_dir.join(format!("{}.log", request.job_id));
        let result_path = request
            .logs_dir
            .join(format!("{}.audio-separator-result.json", request.job_id));
        let stems_json = serde_json::to_string(&request.model.stems)?;

        Self::report(&request, progress, 0.03, "Preparing Audio Separator worker");

        let mut command = Command::new(&python);
        command
            .arg(worker_script)
            .arg("--input")
            .arg(&request.source_path)
            .arg("--output-dir")
            .arg(&request.stems_dir)
            .arg("--model-file-dir")
            .arg(model_file_dir)
            .arg("--model-filename")
            .arg(model_filename)
            .arg("--result-json")
            .arg(&result_path)
            .arg("--log-path")
            .arg(&log_path)
            .arg("--project-name")
            .arg(&request.project_name)
            .arg("--job-id")
            .arg(&request.job_id)
            .arg("--task")
            .arg(task_arg(&request.task))
            .arg("--stems-json")
            .arg(stems_json)
            .arg("--sample-rate")
            .arg(request.model.sample_rate.to_string())
            .arg("--device")
            .arg(Self::device(&request))
            .arg("--mdx-segment-size")
            .arg(
                option_u64(&request.options, "mdxSegmentSize")
                    .or_else(|| option_u64(&request.options, "chunkSize"))
                    .unwrap_or(256)
                    .to_string(),
            )
            .arg("--mdx-overlap")
            .arg(
                option_f64(&request.options, "mdxOverlap")
                    .or_else(|| option_f64(&request.options, "overlap"))
                    .unwrap_or(0.25)
                    .to_string(),
            )
            .arg("--batch-size")
            .arg(
                option_u64(&request.options, "batchSize")
                    .unwrap_or(1)
                    .to_string(),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if option_bool(&request.options, "enableDenoisePass").unwrap_or(false) {
            command.arg("--enable-denoise-pass");
        }

        Self::report(&request, progress, 0.08, "Starting Audio Separator");

        let mut child = command.spawn().map_err(|error| {
            TrackExtractError::UserFacing(format!(
                "Could not start Audio Separator worker with {}: {error}. Run scripts/setup-audio-separator-worker.sh or set TRACKEXTRACT_AUDIO_SEPARATOR_PYTHON.",
                python.display()
            ))
        })?;

        let started = Instant::now();
        let mut last_reported_second = 0;
        let status = loop {
            if cancel_token.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(TrackExtractError::Cancelled);
            }

            if let Some(status) = child.try_wait()? {
                break status;
            }

            let elapsed = started.elapsed().as_secs();
            if elapsed / 2 > last_reported_second {
                last_reported_second = elapsed / 2;
                let progress_amount = (0.12 + (elapsed as f32 / 240.0) * 0.76).min(0.88);
                Self::report(
                    &request,
                    progress,
                    progress_amount,
                    if elapsed < 30 {
                        "Running Audio Separator model"
                    } else {
                        "Still separating audio with Audio Separator"
                    },
                );
            }

            thread::sleep(Duration::from_millis(250));
        };

        if !status.success() {
            let detail = read_log_tail(&log_path).unwrap_or_else(|| {
                format!(
                    "Worker exited with status {status}. Check that audio-separator is installed in {}.",
                    python.display()
                )
            });
            return Err(TrackExtractError::UserFacing(format!(
                "Audio Separator failed: {detail}"
            )));
        }

        Self::report(&request, progress, 0.94, "Collecting generated stems");

        let result_json = fs::read_to_string(&result_path).map_err(|error| {
            TrackExtractError::UserFacing(format!(
                "Audio Separator finished but did not write a result file: {error}"
            ))
        })?;
        let worker_result: WorkerResult = serde_json::from_str(&result_json)?;
        let stems = worker_result
            .stems
            .into_iter()
            .map(|stem| StemFile::new(stem.label, PathBuf::from(stem.path), request.job_id.clone()))
            .collect::<Vec<_>>();

        Self::report(&request, progress, 1.0, "Audio Separator complete");

        Ok(SeparationOutput { stems, log_path })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerResult {
    stems: Vec<WorkerStem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerStem {
    label: String,
    path: String,
}

fn task_arg(task: &TaskType) -> &'static str {
    match task {
        TaskType::VocalsInstrumental => "vocals_instrumental",
        TaskType::FullStemSplit => "full_stem_split",
        TaskType::DrumsOnly => "drums_only",
        TaskType::BassOnly => "bass_only",
        TaskType::GuitarOnly => "guitar_only",
        TaskType::PianoOnly => "piano_only",
        TaskType::ExperimentalBestQuality => "experimental_best_quality",
        TaskType::VocalCleanupChain => "vocal_cleanup_chain",
        TaskType::LayeredVocalCleanup => "layered_vocal_cleanup",
        TaskType::VocalDereverb => "vocal_dereverb",
        TaskType::VocalDenoise => "vocal_denoise",
    }
}

fn option_string(options: &Value, key: &str) -> Option<String> {
    options
        .as_object()
        .and_then(|values| values.get(key))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn option_u64(options: &Value, key: &str) -> Option<u64> {
    options
        .as_object()
        .and_then(|values| values.get(key))
        .and_then(Value::as_u64)
}

fn option_f64(options: &Value, key: &str) -> Option<f64> {
    options
        .as_object()
        .and_then(|values| values.get(key))
        .and_then(Value::as_f64)
}

fn option_bool(options: &Value, key: &str) -> Option<bool> {
    options
        .as_object()
        .and_then(|values| values.get(key))
        .and_then(Value::as_bool)
}

fn candidate_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(current) = env::current_dir() {
        push_with_ancestors(&mut roots, &current);
    }

    push_with_ancestors(&mut roots, Path::new(env!("CARGO_MANIFEST_DIR")));

    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_with_ancestors(&mut roots, parent);
        }
    }

    roots
}

fn push_with_ancestors(roots: &mut Vec<PathBuf>, path: &Path) {
    for candidate in path.ancestors() {
        if !roots.iter().any(|existing| existing == candidate) {
            roots.push(candidate.to_path_buf());
        }
    }
}

fn read_log_tail(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let max_len = 1_400;
    if text.len() <= max_len {
        return Some(text);
    }

    let start = text.len().saturating_sub(max_len);
    Some(text[start..].trim_start().to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use tempfile::tempdir;

    use crate::model_registry::ModelRuntimeConfig;

    use super::*;

    fn write_test_wav(path: &std::path::Path) {
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

    #[test]
    fn stub_backend_writes_valid_wav_stems() {
        let temp = tempdir().expect("tempdir");
        let input = temp.path().join("input.wav");
        write_test_wav(&input);
        let request = SeparationRequest {
            job_id: "job".into(),
            project_name: "Artist - Song".into(),
            source_path: input,
            stems_dir: temp.path().join("stems"),
            logs_dir: temp.path().join("logs"),
            app_data_dir: temp.path().join("app-data"),
            model: ModelEntry {
                id: "stub".into(),
                display_name: "Stub".into(),
                backend: BackendKind::Stub,
                tasks: vec![TaskType::VocalsInstrumental],
                stems: vec!["Vocals".into(), "Instrumental".into()],
                sample_rate: 44_100,
                quality: "development".into(),
                version: "0.1.0".into(),
                installed: true,
                path: String::new(),
                download_url: String::new(),
                source_url: String::new(),
                license: String::new(),
                notes: String::new(),
                download_size_mb: None,
                runtime: ModelRuntimeConfig::default(),
                options: Vec::new(),
            },
            model_path: None,
            task: TaskType::VocalsInstrumental,
            options: serde_json::json!({}),
        };

        let backend = StubSeparationBackend;
        let output = backend
            .run(request, &|_| {}, Arc::new(AtomicBool::new(false)))
            .expect("stub run");

        assert_eq!(output.stems.len(), 2);
        for stem in output.stems {
            let reader = hound::WavReader::open(stem.path).expect("read generated wav");
            assert_eq!(reader.spec().sample_rate, 44_100);
            assert_eq!(reader.spec().bits_per_sample, 16);
            assert_eq!(reader.spec().sample_format, hound::SampleFormat::Int);
        }
    }

    #[test]
    fn audio_separator_backend_reads_worker_result() {
        let temp = tempdir().expect("tempdir");
        let input = temp.path().join("input.wav");
        let model_path = temp.path().join("app-data/models/onnx/test.onnx");
        let worker_path = temp.path().join("fake_audio_separator_worker.py");
        write_test_wav(&input);
        fs::create_dir_all(model_path.parent().unwrap()).expect("model dir");
        fs::write(&model_path, b"fake model").expect("model file");
        fs::write(
            &worker_path,
            r#"#!/usr/bin/env python3
import argparse
import json
import wave
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--output-dir", required=True)
parser.add_argument("--result-json", required=True)
parser.add_argument("--log-path", required=True)
parser.add_argument("--project-name", required=True)
parser.add_argument("--stems-json", required=True)
parser.add_argument("--input")
parser.add_argument("--model-file-dir")
parser.add_argument("--model-filename")
parser.add_argument("--job-id")
parser.add_argument("--task")
parser.add_argument("--sample-rate")
parser.add_argument("--device")
parser.add_argument("--mdx-segment-size")
parser.add_argument("--mdx-overlap")
parser.add_argument("--batch-size")
parser.add_argument("--enable-denoise-pass", action="store_true")
args = parser.parse_args()

output_dir = Path(args.output_dir)
output_dir.mkdir(parents=True, exist_ok=True)
stems = []
for label in json.loads(args.stems_json):
    path = output_dir / f"{args.project_name} - {label}.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(44100)
        wav.writeframes(b"\x00\x00" * 64)
    stems.append({"label": label, "path": str(path)})
Path(args.log_path).write_text("ok\n", encoding="utf-8")
Path(args.result_json).write_text(json.dumps({"stems": stems}), encoding="utf-8")
"#,
        )
        .expect("worker");

        let request = SeparationRequest {
            job_id: "job".into(),
            project_name: "Artist - Song".into(),
            source_path: input,
            stems_dir: temp.path().join("stems"),
            logs_dir: temp.path().join("logs"),
            app_data_dir: temp.path().join("app-data"),
            model: ModelEntry {
                id: "onnx".into(),
                display_name: "ONNX".into(),
                backend: BackendKind::Onnx,
                tasks: vec![TaskType::VocalsInstrumental],
                stems: vec!["Vocals".into(), "Instrumental".into()],
                sample_rate: 44_100,
                quality: "balanced".into(),
                version: "1".into(),
                installed: true,
                path: "models/onnx/test.onnx".into(),
                download_url: String::new(),
                source_url: String::new(),
                license: String::new(),
                notes: String::new(),
                download_size_mb: None,
                runtime: ModelRuntimeConfig {
                    worker_script: worker_path.display().to_string(),
                    ..ModelRuntimeConfig::default()
                },
                options: Vec::new(),
            },
            model_path: Some(model_path),
            task: TaskType::VocalsInstrumental,
            options: serde_json::json!({ "device": "cpu" }),
        };

        let backend = AudioSeparatorBackend;
        let output = backend
            .run(request, &|_| {}, Arc::new(AtomicBool::new(false)))
            .expect("audio separator run");

        assert_eq!(output.stems.len(), 2);
        assert_eq!(output.stems[0].label, "Vocals");
        assert_eq!(output.stems[1].label, "Instrumental");
        for stem in output.stems {
            assert!(stem.path.is_file());
        }
    }
}
