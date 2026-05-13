use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    audio::{read_audio_metadata, AudioMetadata},
    error::{Result, TrackExtractError},
};

pub const SESSION_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    pub id: String,
    pub original_name: String,
    pub source_path: PathBuf,
    pub project_path: PathBuf,
    pub sample_rate: Option<u32>,
    pub channels: Option<usize>,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StemFile {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub source_job_id: String,
    pub muted: bool,
    pub solo: bool,
    pub volume: f32,
}

impl StemFile {
    pub fn new(label: impl Into<String>, path: PathBuf, source_job_id: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            label: label.into(),
            path,
            source_job_id: source_job_id.into(),
            muted: false,
            solo: false,
            volume: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSession {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub root_path: PathBuf,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub original_files: Vec<AudioSource>,
    pub jobs: Vec<String>,
    pub stems: Vec<StemFile>,
}

impl ProjectSession {
    pub fn create(projects_root: &Path, audio_paths: &[PathBuf]) -> Result<Self> {
        if audio_paths.is_empty() {
            return Err(TrackExtractError::NoSourceAudio);
        }

        fs::create_dir_all(projects_root)?;

        let first_name = audio_paths[0]
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled Track");
        let name = sanitize_name(first_name);
        let root_path = unique_project_path(projects_root, &name);

        fs::create_dir_all(root_path.join("original"))?;
        fs::create_dir_all(root_path.join("stems"))?;
        fs::create_dir_all(root_path.join("renders"))?;
        fs::create_dir_all(root_path.join("logs"))?;

        let now = Utc::now();
        let mut session = Self {
            schema_version: SESSION_SCHEMA_VERSION,
            id: Uuid::new_v4().to_string(),
            name,
            root_path,
            created_at: now,
            updated_at: now,
            original_files: Vec::new(),
            jobs: Vec::new(),
            stems: Vec::new(),
        };

        for audio_path in audio_paths {
            session.add_original_file(audio_path)?;
        }

        session.save()?;
        Ok(session)
    }

    pub fn load(path: &Path) -> Result<Self> {
        Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
    }

    pub fn session_path(&self) -> PathBuf {
        self.root_path.join("session.json")
    }

    pub fn stems_dir(&self) -> PathBuf {
        self.root_path.join("stems")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root_path.join("logs")
    }

    pub fn save(&mut self) -> Result<()> {
        self.updated_at = Utc::now();
        fs::write(self.session_path(), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn add_job(&mut self, job_id: &str) -> Result<()> {
        if !self.jobs.iter().any(|existing| existing == job_id) {
            self.jobs.push(job_id.to_string());
        }
        self.save()
    }

    pub fn replace_job_stems(&mut self, job_id: &str, stems: Vec<StemFile>) -> Result<()> {
        self.stems.retain(|stem| stem.source_job_id != job_id);
        self.stems.extend(stems);
        self.save()
    }

    fn add_original_file(&mut self, source_path: &Path) -> Result<()> {
        if !source_path.exists() {
            return Err(TrackExtractError::FileNotFound(source_path.to_path_buf()));
        }

        let original_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("audio")
            .to_string();
        let destination = unique_file_path(&self.root_path.join("original"), &original_name);
        fs::copy(source_path, &destination)?;
        let metadata = read_audio_metadata(&destination).unwrap_or(AudioMetadata {
            sample_rate: None,
            channels: None,
            duration_seconds: None,
        });

        self.original_files.push(AudioSource {
            id: Uuid::new_v4().to_string(),
            original_name,
            source_path: source_path.to_path_buf(),
            project_path: destination,
            sample_rate: metadata.sample_rate,
            channels: metadata.channels,
            duration_seconds: metadata.duration_seconds,
        });

        Ok(())
    }
}

pub fn sanitize_name(input: &str) -> String {
    let sanitized = input
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            character if character.is_control() => '-',
            character => character,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let sanitized = sanitized.trim_matches(['.', ' ', '-']).to_string();
    if sanitized.is_empty() {
        "Untitled Track".to_string()
    } else {
        sanitized
    }
}

pub fn daw_friendly_stem_filename(project_name: &str, stem_label: &str) -> String {
    format!(
        "{} - {}.wav",
        sanitize_name(project_name),
        sanitize_name(stem_label)
    )
}

fn unique_project_path(projects_root: &Path, base_name: &str) -> PathBuf {
    let mut candidate = projects_root.join(base_name);
    let mut suffix = 2;

    while candidate.exists() {
        candidate = projects_root.join(format!("{base_name} {suffix}"));
        suffix += 1;
    }

    candidate
}

fn unique_file_path(parent: &Path, file_name: &str) -> PathBuf {
    let path = parent.join(file_name);
    if !path.exists() {
        return path;
    }

    let original = Path::new(file_name);
    let stem = original
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("audio");
    let extension = original
        .extension()
        .and_then(|extension| extension.to_str());
    let mut suffix = 2;

    loop {
        let candidate_name = match extension {
            Some(extension) => format!("{stem} {suffix}.{extension}"),
            None => format!("{stem} {suffix}"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
        suffix += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &Path) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44_100,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav writer");
        for _ in 0..128 {
            writer.write_sample(0.0_f32).expect("sample");
        }
        writer.finalize().expect("finalize");
    }

    #[test]
    fn project_creation_writes_expected_structure_and_session() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("Artist - Song.wav");
        write_test_wav(&source);

        let session = ProjectSession::create(&temp.path().join("projects"), &[source])
            .expect("project creation");

        assert!(session.root_path.join("original").is_dir());
        assert!(session.root_path.join("stems").is_dir());
        assert!(session.root_path.join("renders").is_dir());
        assert!(session.root_path.join("logs").is_dir());
        assert!(session.session_path().is_file());
        assert_eq!(session.name, "Artist - Song");
    }

    #[test]
    fn sanitize_name_replaces_invalid_characters_and_trims_edges() {
        assert_eq!(sanitize_name(" ../Bad:/Name?*<>| "), "Bad--Name");
    }

    #[test]
    fn sanitize_name_falls_back_for_empty_names() {
        assert_eq!(sanitize_name(" . - \n\t"), "Untitled Track");
    }

    #[test]
    fn daw_friendly_stem_filename_sanitizes_project_and_stem_names() {
        assert_eq!(
            daw_friendly_stem_filename("Artist/Song", "Lead: Vocal?"),
            "Artist-Song - Lead- Vocal.wav"
        );
    }

    #[test]
    fn project_creation_requires_at_least_one_source() {
        let temp = tempfile::tempdir().expect("tempdir");

        let error = ProjectSession::create(&temp.path().join("projects"), &[])
            .expect_err("empty import should fail");

        assert!(matches!(error, TrackExtractError::NoSourceAudio));
    }

    #[test]
    fn project_creation_rejects_missing_source_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let missing = temp.path().join("missing.wav");

        let error = ProjectSession::create(&temp.path().join("projects"), &[missing.clone()])
            .expect_err("missing source should fail");

        assert!(matches!(error, TrackExtractError::FileNotFound(path) if path == missing));
    }

    #[test]
    fn project_creation_uses_unique_project_folder_names() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("Artist - Song.wav");
        write_test_wav(&source);
        let projects = temp.path().join("projects");

        let first = ProjectSession::create(&projects, &[source.clone()]).expect("first project");
        let second = ProjectSession::create(&projects, &[source]).expect("second project");

        assert_eq!(first.name, "Artist - Song");
        assert_eq!(second.name, "Artist - Song");
        assert_ne!(first.root_path, second.root_path);
        assert_eq!(second.root_path.file_name().unwrap(), "Artist - Song 2");
    }

    #[test]
    fn duplicate_original_file_names_are_preserved_with_suffixes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source_a_dir = temp.path().join("a");
        let source_b_dir = temp.path().join("b");
        fs::create_dir_all(&source_a_dir).expect("a dir");
        fs::create_dir_all(&source_b_dir).expect("b dir");
        let source_a = source_a_dir.join("Song.wav");
        let source_b = source_b_dir.join("Song.wav");
        write_test_wav(&source_a);
        write_test_wav(&source_b);

        let session = ProjectSession::create(&temp.path().join("projects"), &[source_a, source_b])
            .expect("project");
        let stored_names = session
            .original_files
            .iter()
            .map(|source| {
                source
                    .project_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();

        assert_eq!(stored_names, vec!["Song.wav", "Song 2.wav"]);
    }

    #[test]
    fn project_session_loads_saved_json_roundtrip() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("Artist - Song.wav");
        write_test_wav(&source);

        let session =
            ProjectSession::create(&temp.path().join("projects"), &[source]).expect("project");
        let loaded = ProjectSession::load(&session.session_path()).expect("load session");

        assert_eq!(loaded.id, session.id);
        assert_eq!(loaded.name, session.name);
        assert_eq!(loaded.original_files.len(), 1);
    }

    #[test]
    fn add_job_is_idempotent_and_persists() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("Artist - Song.wav");
        write_test_wav(&source);
        let mut session =
            ProjectSession::create(&temp.path().join("projects"), &[source]).expect("project");

        session.add_job("job-1").expect("add job");
        session.add_job("job-1").expect("add duplicate job");
        let loaded = ProjectSession::load(&session.session_path()).expect("load");

        assert_eq!(session.jobs, vec!["job-1"]);
        assert_eq!(loaded.jobs, vec!["job-1"]);
    }

    #[test]
    fn replace_job_stems_replaces_only_matching_job_stems() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("Artist - Song.wav");
        write_test_wav(&source);
        let mut session =
            ProjectSession::create(&temp.path().join("projects"), &[source]).expect("project");
        let other_stem = StemFile::new("Drums", session.stems_dir().join("drums.wav"), "job-2");
        session.stems.push(StemFile::new(
            "Vocals",
            session.stems_dir().join("old-vocals.wav"),
            "job-1",
        ));
        session.stems.push(other_stem.clone());

        let new_stems = vec![StemFile::new(
            "Vocals",
            session.stems_dir().join("new-vocals.wav"),
            "job-1",
        )];
        session
            .replace_job_stems("job-1", new_stems)
            .expect("replace stems");

        assert_eq!(session.stems.len(), 2);
        assert!(session
            .stems
            .iter()
            .any(|stem| stem.path.ends_with("new-vocals.wav")));
        assert!(session.stems.iter().any(|stem| stem.id == other_stem.id));
        assert!(!session
            .stems
            .iter()
            .any(|stem| stem.path.ends_with("old-vocals.wav")));
    }

    #[test]
    fn wav_import_records_basic_audio_metadata() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("Artist - Song.wav");
        write_test_wav(&source);

        let session =
            ProjectSession::create(&temp.path().join("projects"), &[source]).expect("project");
        let imported = &session.original_files[0];

        assert_eq!(imported.sample_rate, Some(44_100));
        assert_eq!(imported.channels, Some(1));
        assert!(imported.duration_seconds.unwrap_or_default() > 0.0);
    }
}
