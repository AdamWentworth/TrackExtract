use std::{fs::File, path::Path};

use symphonia::{
    core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SymphoniaError,
        formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
    },
    default::{get_codecs, get_probe},
};

use crate::error::{Result, TrackExtractError};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    pub sample_rate: Option<u32>,
    pub channels: Option<usize>,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct DecodedAudio {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

pub fn read_audio_metadata(path: impl AsRef<Path>) -> Result<AudioMetadata> {
    let path = path.as_ref();
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();

    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }

    let probed = get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|err| TrackExtractError::Audio(err.to_string()))?;

    let track = probed
        .format
        .default_track()
        .ok_or_else(|| TrackExtractError::Audio("No default audio track found".to_string()))?;
    let params = &track.codec_params;
    let sample_rate = params.sample_rate;
    let channels = params.channels.map(|channels| channels.count());
    let duration_seconds = match (params.n_frames, sample_rate) {
        (Some(frames), Some(rate)) if rate > 0 => Some(frames as f64 / rate as f64),
        _ => None,
    };

    Ok(AudioMetadata {
        sample_rate,
        channels,
        duration_seconds,
    })
}

pub fn decode_audio_file(path: impl AsRef<Path>) -> Result<DecodedAudio> {
    let path = path.as_ref();
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();

    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }

    let probed = get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|err| TrackExtractError::Audio(err.to_string()))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| TrackExtractError::Audio("No default audio track found".to_string()))?;
    let track_id = track.id;
    let mut decoder = get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|err| TrackExtractError::Audio(err.to_string()))?;

    let mut sample_buffer: Option<SampleBuffer<f32>> = None;
    let mut samples = Vec::new();
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut channels = track
        .codec_params
        .channels
        .map(|channels| channels.count() as u16)
        .unwrap_or(2);

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::ResetRequired) => break,
            Err(err) => return Err(TrackExtractError::Audio(err.to_string())),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(err) => return Err(TrackExtractError::Audio(err.to_string())),
        };

        let spec = *decoded.spec();
        sample_rate = spec.rate;
        channels = spec.channels.count() as u16;

        let duration = decoded.capacity() as u64;
        if sample_buffer
            .as_ref()
            .map(|buffer| buffer.capacity() < decoded.capacity())
            .unwrap_or(true)
        {
            sample_buffer = Some(SampleBuffer::<f32>::new(duration, spec));
        }

        let buffer = sample_buffer
            .as_mut()
            .expect("sample buffer is created before use");
        buffer.copy_interleaved_ref(decoded);
        samples.extend_from_slice(buffer.samples());
    }

    if samples.is_empty() {
        return Err(TrackExtractError::Audio(
            "The file did not contain decodable audio samples".to_string(),
        ));
    }

    Ok(DecodedAudio {
        sample_rate,
        channels,
        samples,
    })
}

pub fn write_wav(path: impl AsRef<Path>, audio: &DecodedAudio, gain: f32) -> Result<()> {
    let spec = hound::WavSpec {
        channels: audio.channels,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)?;

    for sample in &audio.samples {
        let normalized = (sample * gain).clamp(-1.0, 1.0);
        writer.write_sample((normalized * i16::MAX as f32) as i16)?;
    }

    writer.finalize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write_test_wav(path: &Path) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav writer");
        for index in 0..128 {
            let sample = (index as f32 / 128.0) - 0.5;
            writer.write_sample(sample).expect("left");
            writer.write_sample(-sample).expect("right");
        }
        writer.finalize().expect("finalize");
    }

    #[test]
    fn reads_wav_metadata() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("source.wav");
        write_test_wav(&path);

        let metadata = read_audio_metadata(&path).expect("metadata");

        assert_eq!(metadata.sample_rate, Some(48_000));
        assert_eq!(metadata.channels, Some(2));
        assert!(metadata.duration_seconds.unwrap_or_default() > 0.0);
    }

    #[test]
    fn decodes_wav_to_interleaved_float_samples() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("source.wav");
        write_test_wav(&path);

        let decoded = decode_audio_file(&path).expect("decode");

        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.samples.len(), 256);
    }

    #[test]
    fn write_wav_outputs_sixteen_bit_pcm_with_gain_and_clamping() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("output.wav");
        let audio = DecodedAudio {
            sample_rate: 44_100,
            channels: 1,
            samples: vec![-2.0, -0.5, 0.0, 0.5, 2.0],
        };

        write_wav(&path, &audio, 0.75).expect("write wav");
        let mut reader = hound::WavReader::open(&path).expect("reader");
        let spec = reader.spec();
        let samples = reader
            .samples::<i16>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("samples");

        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 44_100);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(spec.sample_format, hound::SampleFormat::Int);
        assert_eq!(samples[0], i16::MIN + 1);
        assert_eq!(samples[2], 0);
        assert_eq!(samples[4], i16::MAX);
    }

    #[test]
    fn decode_missing_file_returns_io_error() {
        let temp = tempfile::tempdir().expect("tempdir");
        let missing = temp.path().join("missing.wav");

        let error = decode_audio_file(&missing).expect_err("missing file");

        assert!(matches!(error, TrackExtractError::Io(_)));
    }

    #[test]
    fn decode_rejects_non_audio_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("not-audio.wav");
        fs::write(&path, b"not audio").expect("write");

        let error = decode_audio_file(&path).expect_err("invalid audio");

        assert!(matches!(error, TrackExtractError::Audio(_)));
    }
}
