use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use serde::{Deserialize, Serialize};

use crate::error::{Result, TrackExtractError};

#[derive(Debug, Clone)]
pub struct ModelInstallRequest {
    pub model_id: String,
    pub display_name: String,
    pub download_url: String,
    pub destination_path: PathBuf,
    pub temp_path: PathBuf,
    pub expected_size_mb: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgress {
    pub model_id: String,
    pub progress: f32,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub message: String,
}

pub fn download_model_file(
    request: ModelInstallRequest,
    progress: &(dyn Fn(ModelDownloadProgress) + Send + Sync),
    cancel_token: Arc<AtomicBool>,
) -> Result<PathBuf> {
    if request.destination_path.exists() {
        progress(ModelDownloadProgress {
            model_id: request.model_id.clone(),
            progress: 1.0,
            bytes_downloaded: request.destination_path.metadata()?.len(),
            total_bytes: request
                .destination_path
                .metadata()
                .ok()
                .map(|metadata| metadata.len()),
            message: "Model already installed".to_string(),
        });
        return Ok(request.destination_path);
    }

    if let Some(parent) = request.destination_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = request.temp_path.parent() {
        fs::create_dir_all(parent)?;
    }

    progress(ModelDownloadProgress {
        model_id: request.model_id.clone(),
        progress: 0.0,
        bytes_downloaded: 0,
        total_bytes: request.expected_size_mb.map(mb_to_bytes),
        message: format!("Downloading {}", request.display_name),
    });

    let client = reqwest::blocking::Client::builder()
        .user_agent("TrackExtract/0.1 model-installer")
        .build()
        .map_err(network_error)?;
    let mut response = client
        .get(&request.download_url)
        .send()
        .map_err(network_error)?;

    if !response.status().is_success() {
        return Err(TrackExtractError::UserFacing(format!(
            "Model download failed with HTTP status {}",
            response.status()
        )));
    }

    let response_total = response.content_length();
    let total_bytes = response_total.or_else(|| request.expected_size_mb.map(mb_to_bytes));
    let mut file = File::create(&request.temp_path)?;
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        if cancel_token.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&request.temp_path);
            return Err(TrackExtractError::Cancelled);
        }

        let read = response.read(&mut buffer)?;
        if read == 0 {
            break;
        }

        file.write_all(&buffer[..read])?;
        downloaded += read as u64;

        let amount = total_bytes
            .filter(|total| *total > 0)
            .map(|total| (downloaded as f32 / total as f32).min(0.99))
            .unwrap_or(0.0);

        progress(ModelDownloadProgress {
            model_id: request.model_id.clone(),
            progress: amount,
            bytes_downloaded: downloaded,
            total_bytes,
            message: format!("Downloaded {}", format_bytes(downloaded)),
        });
    }

    file.flush()?;
    drop(file);
    fs::rename(&request.temp_path, &request.destination_path)?;

    progress(ModelDownloadProgress {
        model_id: request.model_id,
        progress: 1.0,
        bytes_downloaded: downloaded,
        total_bytes: total_bytes.or(Some(downloaded)),
        message: "Model installed".to_string(),
    });

    Ok(request.destination_path)
}

fn mb_to_bytes(value: u32) -> u64 {
    value as u64 * 1024 * 1024
}

fn network_error(error: reqwest::Error) -> TrackExtractError {
    TrackExtractError::UserFacing(format!("Network error while downloading model: {error}"))
}

fn format_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes < 1024 * 1024 {
        format!("{} KB", (bytes / 1024).max(1))
    } else {
        format!("{:.1} MB", bytes as f64 / MB)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read as _, Write as _},
        net::TcpListener,
        sync::{atomic::AtomicBool, Arc, Mutex},
        thread,
    };

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn downloads_model_file_and_reports_completion() {
        let body = b"tiny model";
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let url = format!("http://{}", listener.local_addr().expect("addr"));

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("headers");
            stream.write_all(body).expect("body");
        });

        let temp = tempdir().expect("tempdir");
        let destination = temp.path().join("models/onnx/tiny.onnx");
        let request = ModelInstallRequest {
            model_id: "tiny".to_string(),
            display_name: "Tiny".to_string(),
            download_url: url,
            destination_path: destination.clone(),
            temp_path: destination.with_extension("onnx.download"),
            expected_size_mb: None,
        };
        let progress = Arc::new(Mutex::new(Vec::new()));
        let progress_for_callback = progress.clone();

        let downloaded = download_model_file(
            request,
            &|event| progress_for_callback.lock().expect("progress").push(event),
            Arc::new(AtomicBool::new(false)),
        )
        .expect("download");

        assert_eq!(downloaded, destination);
        assert_eq!(fs::read(&downloaded).expect("downloaded bytes"), body);
        let events = progress.lock().expect("progress events");
        assert_eq!(events.last().expect("last event").progress, 1.0);
    }

    #[test]
    fn existing_destination_short_circuits_download() {
        let temp = tempdir().expect("tempdir");
        let destination = temp.path().join("models/onnx/existing.onnx");
        std::fs::create_dir_all(destination.parent().expect("parent")).expect("dir");
        std::fs::write(&destination, b"existing").expect("existing");
        let request = ModelInstallRequest {
            model_id: "existing".to_string(),
            display_name: "Existing".to_string(),
            download_url: "http://127.0.0.1:1/never".to_string(),
            destination_path: destination.clone(),
            temp_path: destination.with_extension("onnx.download"),
            expected_size_mb: Some(1),
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_callback = events.clone();

        let installed = download_model_file(
            request,
            &|event| events_for_callback.lock().expect("events").push(event),
            Arc::new(AtomicBool::new(false)),
        )
        .expect("existing install");

        assert_eq!(installed, destination);
        assert_eq!(std::fs::read(&installed).expect("bytes"), b"existing");
        assert_eq!(events.lock().expect("events").len(), 1);
        assert_eq!(
            events.lock().expect("events")[0].message,
            "Model already installed"
        );
    }

    #[test]
    fn http_error_returns_user_facing_error() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let url = format!("http://{}", listener.local_addr().expect("addr"));

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .expect("response");
        });

        let temp = tempdir().expect("tempdir");
        let destination = temp.path().join("models/onnx/missing.onnx");
        let request = ModelInstallRequest {
            model_id: "missing".to_string(),
            display_name: "Missing".to_string(),
            download_url: url,
            destination_path: destination,
            temp_path: temp.path().join("models/onnx/missing.onnx.download"),
            expected_size_mb: None,
        };

        let error = download_model_file(request, &|_| {}, Arc::new(AtomicBool::new(false)))
            .expect_err("404 should fail");

        assert!(
            matches!(error, TrackExtractError::UserFacing(message) if message.contains("HTTP status"))
        );
    }

    #[test]
    fn pre_cancelled_download_removes_partial_temp_file() {
        let body = vec![7_u8; 128 * 1024];
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let url = format!("http://{}", listener.local_addr().expect("addr"));

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("headers");
            stream.write_all(&body).expect("body");
        });

        let temp = tempdir().expect("tempdir");
        let destination = temp.path().join("models/onnx/cancel.onnx");
        let temp_path = destination.with_extension("onnx.download");
        let request = ModelInstallRequest {
            model_id: "cancel".to_string(),
            display_name: "Cancel".to_string(),
            download_url: url,
            destination_path: destination,
            temp_path: temp_path.clone(),
            expected_size_mb: None,
        };
        let cancel_token = Arc::new(AtomicBool::new(true));

        let error = download_model_file(request, &|_| {}, cancel_token).expect_err("cancelled");

        assert!(matches!(error, TrackExtractError::Cancelled));
        assert!(!temp_path.exists());
    }
}
