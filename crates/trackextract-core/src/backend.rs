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
    pub model: ModelEntry,
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
}
