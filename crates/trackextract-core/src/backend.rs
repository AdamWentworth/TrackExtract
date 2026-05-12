use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use tempfile::tempdir;

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
            },
            task: TaskType::VocalsInstrumental,
        };

        let backend = StubSeparationBackend;
        let output = backend
            .run(request, &|_| {}, Arc::new(AtomicBool::new(false)))
            .expect("stub run");

        assert_eq!(output.stems.len(), 2);
        for stem in output.stems {
            let reader = hound::WavReader::open(stem.path).expect("read generated wav");
            assert_eq!(reader.spec().sample_rate, 44_100);
        }
    }
}
