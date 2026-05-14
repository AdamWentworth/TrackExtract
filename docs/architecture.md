# TrackExtract Architecture

TrackExtract is a Tauri + React desktop app with a Python-first engine. Rust is intentionally thin: it owns desktop plumbing, process spawning, cancellation, local media preview, app paths, and event forwarding.

```text
React/Tauri UI
  -> Tauri commands/events
  -> thin Rust bridge
  -> Python TrackExtract engine
     -> project/session manager
     -> model registry
     -> job queue
     -> audio file handling
     -> output folder management
     -> logging/progress events
     -> backend selection
        -> Demucs provider
        -> audio-separator provider
        -> Stub provider
```

The canonical engine source lives in `engine/src`, packaged as `trackextract_engine` by `engine/pyproject.toml`. The Tauri bridge calls the installed module with:

```bash
python -m trackextract_engine <command>
```

Long-running engine commands emit JSONL envelopes so Rust can forward progress and state changes to the frontend:

```json
{"type":"event","name":"job_progress","payload":{}}
{"type":"event","name":"job_state_changed","payload":{}}
{"type":"result","payload":{}}
```

The MVP is offline render-first. It does not assume real-time separation, automatic DAW track creation, cloud processing, accounts, or payment logic.
