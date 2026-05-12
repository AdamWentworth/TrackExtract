use std::sync::{atomic::AtomicBool, Arc};

use trackextract_core::{Engine, JobState, SeparationBackend, StubSeparationBackend, TaskType};

const TEST_MODELS: &str = r#"[
  {
    "id": "stub_vocals_instrumental",
    "displayName": "Stub Vocals / Instrumental",
    "backend": "stub",
    "tasks": ["vocals_instrumental"],
    "stems": ["Vocals", "Instrumental"],
    "sampleRate": 44100,
    "quality": "development",
    "version": "0.1.0",
    "installed": true,
    "path": "",
    "downloadUrl": ""
  }
]"#;

#[test]
fn import_stub_render_and_export_flow() {
    let temp = tempfile::tempdir().expect("tempdir");
    let source_path = temp.path().join("Artist - Song.wav");
    write_test_wav(&source_path);

    let mut engine = Engine::bootstrap_with_paths(
        TEST_MODELS,
        temp.path().join("app-data"),
        temp.path().join("TrackExtract Projects"),
    )
    .expect("engine");

    let project = engine
        .import_audio_files(vec![source_path])
        .expect("import project");
    assert!(project.root_path.join("original").is_dir());
    assert!(project.root_path.join("stems").is_dir());
    assert!(project.root_path.join("logs").is_dir());

    let job = engine
        .enqueue_separation(TaskType::VocalsInstrumental, None, None)
        .expect("enqueue");
    let (_prepared, request) = engine.prepare_job(&job.id).expect("prepare");
    engine.mark_job_running(&job.id).expect("running");

    let backend = StubSeparationBackend;
    let output = backend
        .run(request, &|_| {}, Arc::new(AtomicBool::new(false)))
        .expect("stub render");
    let completed = engine.complete_job(&job.id, output).expect("complete");

    assert_eq!(completed.state, JobState::Complete);
    assert_eq!(completed.stems.len(), 2);

    let project = engine.current_project().expect("project after render");
    assert_eq!(project.stems.len(), 2);
    for stem in &project.stems {
        assert!(stem.path.is_file());
    }

    let exported = engine
        .export_stems(&[], &temp.path().join("export"))
        .expect("export");
    assert_eq!(exported.len(), 2);
    for path in exported {
        assert!(path.is_file());
    }
}

fn write_test_wav(path: &std::path::Path) {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 44_100,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("wav writer");
    for index in 0..2048 {
        let sample = ((index as f32 / 2048.0) * 0.4) - 0.2;
        writer.write_sample(sample).expect("left");
        writer.write_sample(-sample).expect("right");
    }
    writer.finalize().expect("finalize");
}
