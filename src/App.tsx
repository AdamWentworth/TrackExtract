import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  ExternalLink,
  FolderOpen,
  ListMusic,
  Music2,
  Pause,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Upload,
  X,
} from "lucide-react";
import "./App.css";

type TaskType =
  | "vocals_instrumental"
  | "full_stem_split"
  | "drums_only"
  | "bass_only"
  | "guitar_only"
  | "piano_only"
  | "experimental_best_quality";

type JobState =
  | "queued"
  | "preparing"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

type BackendKind = "stub" | "onnx" | "pytorch-worker" | "external-process";

interface ModelEntry {
  id: string;
  displayName: string;
  backend: BackendKind;
  tasks: TaskType[];
  stems: string[];
  sampleRate: number;
  quality: string;
  version: string;
  installed: boolean;
  path: string;
  downloadUrl: string;
}

interface AudioSource {
  id: string;
  originalName: string;
  sourcePath: string;
  projectPath: string;
  sampleRate: number | null;
  channels: number | null;
  durationSeconds: number | null;
}

interface StemFile {
  id: string;
  label: string;
  path: string;
  sourceJobId: string;
  muted: boolean;
  solo: boolean;
  volume: number;
}

interface ProjectSession {
  schemaVersion: number;
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  originalFiles: AudioSource[];
  jobs: string[];
  stems: StemFile[];
}

interface JobRecord {
  id: string;
  projectId: string;
  projectName: string;
  sourceId: string;
  sourcePath: string;
  task: TaskType;
  modelId: string;
  state: JobState;
  progress: number;
  statusMessage: string;
  error: string | null;
  stems: StemFile[];
  logPath: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BootstrapState {
  projectRoot: string;
  appDataDir: string;
  modelRegistryPath: string;
  models: ModelEntry[];
  currentProject: ProjectSession | null;
  jobs: JobRecord[];
}

interface BackendProgress {
  jobId: string;
  progress: number;
  message: string;
}

interface PreviewState {
  muted: boolean;
  solo: boolean;
  volume: number;
}

const TASKS: Array<{ value: TaskType; label: string; short: string }> = [
  { value: "vocals_instrumental", label: "Vocals / Instrumental", short: "Vocal split" },
  { value: "full_stem_split", label: "Full Stem Split", short: "6 stems" },
  { value: "drums_only", label: "Drums Only", short: "Drums" },
  { value: "bass_only", label: "Bass Only", short: "Bass" },
  { value: "guitar_only", label: "Guitar Only", short: "Guitar" },
  { value: "piano_only", label: "Piano Only", short: "Piano" },
  {
    value: "experimental_best_quality",
    label: "Experimental / Best Quality",
    short: "Best",
  },
];

const AUDIO_EXTENSIONS = ["wav", "aiff", "aif", "flac", "mp3", "m4a"];

function App() {
  const [boot, setBoot] = useState<BootstrapState | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [project, setProject] = useState<ProjectSession | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [task, setTask] = useState<TaskType>("vocals_instrumental");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [selectedStemIds, setSelectedStemIds] = useState<string[]>([]);
  const [previewState, setPreviewState] = useState<Record<string, PreviewState>>({});
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [logEntries, setLogEntries] = useState<string[]>([]);

  const mergeJob = useCallback((updated: JobRecord) => {
    setJobs((existing) => {
      const found = existing.some((job) => job.id === updated.id);
      if (!found) {
        return [updated, ...existing];
      }
      return existing.map((job) => (job.id === updated.id ? updated : job));
    });
  }, []);

  const importAudioPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setStatus("Creating project session");

    try {
      const imported = await invoke<ProjectSession>("import_audio_files", { paths });
      setProject(imported);
      setSelectedSourceId(imported.originalFiles[0]?.id ?? "");
      setSelectedStemIds([]);
      setPreviewState({});
      setStatus(`Imported ${imported.originalFiles.length} file${imported.originalFiles.length === 1 ? "" : "s"}`);
      const refreshedJobs = await invoke<JobRecord[]>("get_jobs");
      setJobs(refreshedJobs);
    } catch (caught) {
      setError(String(caught));
      setStatus("Import failed");
    } finally {
      setIsBusy(false);
    }
  }, []);

  useEffect(() => {
    let cleanup = () => {};

    async function bootstrap() {
      try {
        const snapshot = await invoke<BootstrapState>("bootstrap_app");
        setBoot(snapshot);
        setModels(snapshot.models);
        setProject(snapshot.currentProject);
        setJobs(snapshot.jobs);
        setSelectedSourceId(snapshot.currentProject?.originalFiles[0]?.id ?? "");
        setStatus("Ready");
      } catch (caught) {
        setError(String(caught));
        setStatus("Startup failed");
      }
    }

    async function bindEvents() {
      const unlistenProgress = await listen<BackendProgress>("job_progress", (event) => {
        setStatus(event.payload.message);
      });
      const unlistenJob = await listen<JobRecord>("job_state_changed", (event) => {
        mergeJob(event.payload);
      });
      const unlistenProject = await listen<ProjectSession>("project_updated", (event) => {
        setProject(event.payload);
      });
      const unlistenLog = await listen<string>("log_entry", (event) => {
        setLogEntries((entries) => [event.payload, ...entries].slice(0, 6));
      });

      cleanup = () => {
        unlistenProgress();
        unlistenJob();
        unlistenProject();
        unlistenLog();
      };
    }

    bootstrap();
    bindEvents();

    return () => cleanup();
  }, [mergeJob]);

  useEffect(() => {
    let unlistenDragDrop: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload as { type?: string; paths?: string[] };
        if (payload.type === "drop" && payload.paths) {
          importAudioPaths(payload.paths);
        }
      })
      .then((unlisten) => {
        unlistenDragDrop = unlisten;
      })
      .catch(() => undefined);

    return () => unlistenDragDrop?.();
  }, [importAudioPaths]);

  useEffect(() => {
    const compatible = models.filter((model) => model.tasks.includes(task));
    const preferred = compatible.find((model) => model.installed) ?? compatible[0];

    if (preferred && !compatible.some((model) => model.id === selectedModelId)) {
      setSelectedModelId(preferred.id);
    }
  }, [models, selectedModelId, task]);

  useEffect(() => {
    if (!project) {
      return;
    }

    setSelectedStemIds((selected) => {
      const existingIds = new Set(project.stems.map((stem) => stem.id));
      const kept = selected.filter((id) => existingIds.has(id));
      return kept.length > 0 ? kept : project.stems.map((stem) => stem.id);
    });

    setPreviewState((existing) => {
      const next = { ...existing };
      for (const stem of project.stems) {
        next[stem.id] ??= { muted: stem.muted, solo: stem.solo, volume: stem.volume };
      }
      return next;
    });
  }, [project]);

  const compatibleModels = useMemo(
    () => models.filter((model) => model.tasks.includes(task)),
    [models, task],
  );
  const selectedModel = compatibleModels.find((model) => model.id === selectedModelId);
  const runningJob = jobs.find((job) => job.state === "running" || job.state === "preparing");
  const latestJob = jobs[0];
  const soloActive = Object.values(previewState).some((state) => state.solo);

  async function chooseFiles() {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });

    if (!selected) {
      return;
    }

    await importAudioPaths(Array.isArray(selected) ? selected : [selected]);
  }

  async function refreshModels() {
    const refreshed = await invoke<ModelEntry[]>("list_models");
    setModels(refreshed);
    setStatus("Model registry refreshed");
  }

  async function runSeparation() {
    if (!project || !selectedModel) {
      setError("Import an audio file and choose an installed model first.");
      return;
    }

    if (!selectedModel.installed) {
      setError(`${selectedModel.displayName} is not installed yet.`);
      return;
    }

    setIsBusy(true);
    setError(null);
    setStatus("Queueing separation job");

    try {
      const queued = await invoke<JobRecord>("enqueue_separation", {
        task,
        modelId: selectedModel.id,
        sourceId: selectedSourceId || null,
      });
      mergeJob(queued);
      await invoke<JobRecord>("start_job", { jobId: queued.id });
      setStatus("Separation complete");
    } catch (caught) {
      setError(String(caught));
      setStatus("Separation failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function cancelRunningJob() {
    if (!runningJob) {
      return;
    }

    const cancelled = await invoke<JobRecord>("cancel_job", { jobId: runningJob.id });
    mergeJob(cancelled);
    setStatus("Cancellation requested");
  }

  async function exportSelectedStems() {
    if (!project || project.stems.length === 0) {
      return;
    }

    const destination = await open({ directory: true, multiple: false });
    if (!destination || Array.isArray(destination)) {
      return;
    }

    try {
      const exported = await invoke<string[]>("export_stems", {
        stemIds: selectedStemIds,
        destinationPath: destination,
      });
      setStatus(`Exported ${exported.length} stem${exported.length === 1 ? "" : "s"}`);
    } catch (caught) {
      setError(String(caught));
      setStatus("Export failed");
    }
  }

  async function revealCurrentProject() {
    if (project) {
      await invoke("reveal_path", { path: project.rootPath });
    } else if (boot) {
      await invoke("reveal_path", { path: boot.projectRoot });
    }
  }

  function setStemPreview(id: string, patch: Partial<PreviewState>) {
    setPreviewState((existing) => {
      const current = existing[id] ?? { muted: false, solo: false, volume: 1 };
      return {
        ...existing,
        [id]: { ...current, ...patch },
      };
    });
  }

  function toggleStemSelection(id: string) {
    setSelectedStemIds((selected) =>
      selected.includes(id) ? selected.filter((candidate) => candidate !== id) : [...selected, id],
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Phlosion</p>
          <h1>TrackExtract</h1>
        </div>
        <div className="status-strip" aria-live="polite">
          <span className={`status-dot ${error ? "is-error" : runningJob ? "is-running" : ""}`} />
          <span>{error ?? status}</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="rail">
          <section className="panel import-panel">
            <div className="panel-heading">
              <Upload aria-hidden />
              <h2>Import</h2>
            </div>
            <button className="drop-zone" type="button" onClick={chooseFiles} disabled={isBusy}>
              <Music2 aria-hidden />
              <span>Drop audio here</span>
              <small>WAV, AIFF, FLAC, MP3, M4A</small>
            </button>

            {project ? (
              <div className="project-summary">
                <strong>{project.name}</strong>
                <span>{project.originalFiles.length} source file{project.originalFiles.length === 1 ? "" : "s"}</span>
                <button className="icon-button" type="button" onClick={revealCurrentProject} title="Reveal project folder">
                  <ExternalLink aria-hidden />
                </button>
              </div>
            ) : (
              <p className="empty-copy">Start with a full mix or batch of tracks.</p>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <SlidersHorizontal aria-hidden />
              <h2>Task</h2>
            </div>
            <div className="task-grid" role="radiogroup" aria-label="Separation task">
              {TASKS.map((taskOption) => (
                <button
                  className={task === taskOption.value ? "task-option is-selected" : "task-option"}
                  key={taskOption.value}
                  type="button"
                  onClick={() => setTask(taskOption.value)}
                >
                  <span>{taskOption.label}</span>
                  <small>{taskOption.short}</small>
                </button>
              ))}
            </div>

            {project && project.originalFiles.length > 1 ? (
              <label className="field-label">
                Source
                <select
                  value={selectedSourceId}
                  onChange={(event) => setSelectedSourceId(event.currentTarget.value)}
                >
                  {project.originalFiles.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.originalName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </section>
        </aside>

        <section className="main-column">
          <section className="panel run-panel">
            <div>
              <div className="panel-heading">
                <ListMusic aria-hidden />
                <h2>Queue</h2>
              </div>
              <p className="panel-copy">
                Curated presets stay simple now, while the Rust engine keeps backend choices replaceable later.
              </p>
            </div>
            <div className="run-actions">
              <button
                className="primary-action"
                type="button"
                onClick={runSeparation}
                disabled={!project || !selectedModel?.installed || isBusy}
              >
                {runningJob ? <Pause aria-hidden /> : <Play aria-hidden />}
                Run separation
              </button>
              <button className="icon-action" type="button" onClick={cancelRunningJob} disabled={!runningJob} title="Cancel job">
                <Square aria-hidden />
              </button>
            </div>
          </section>

          <section className="panel queue-panel">
            {jobs.length === 0 ? (
              <div className="empty-state">
                <ListMusic aria-hidden />
                <span>No jobs queued yet</span>
              </div>
            ) : (
              jobs.map((job) => (
                <article className="job-row" key={job.id}>
                  <div>
                    <strong>{formatTask(job.task)}</strong>
                    <span>{job.statusMessage}</span>
                  </div>
                  <div className="job-progress" aria-label={`${Math.round(job.progress * 100)} percent`}>
                    <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
                  </div>
                  <StateBadge state={job.state} />
                </article>
              ))
            )}
          </section>

          <section className="panel preview-panel">
            <div className="panel-heading">
              <Music2 aria-hidden />
              <h2>Stem Preview</h2>
            </div>

            {!project || project.stems.length === 0 ? (
              <div className="empty-state">
                <Music2 aria-hidden />
                <span>Generated stems will appear here.</span>
              </div>
            ) : (
              <div className="stem-list">
                {project.stems.map((stem) => (
                  <StemPreview
                    key={stem.id}
                    selected={selectedStemIds.includes(stem.id)}
                    soloActive={soloActive}
                    state={previewState[stem.id] ?? { muted: false, solo: false, volume: 1 }}
                    stem={stem}
                    onSelect={() => toggleStemSelection(stem.id)}
                    onUpdate={(patch) => setStemPreview(stem.id, patch)}
                  />
                ))}
              </div>
            )}
          </section>
        </section>

        <aside className="rail">
          <section className="panel model-panel">
            <div className="panel-heading with-action">
              <span>
                <Database aria-hidden />
                <h2>Models</h2>
              </span>
              <button className="icon-button" type="button" onClick={refreshModels} title="Refresh model registry">
                <RefreshCw aria-hidden />
              </button>
            </div>
            <div className="model-list">
              {compatibleModels.map((model) => (
                <button
                  className={selectedModelId === model.id ? "model-row is-selected" : "model-row"}
                  key={model.id}
                  type="button"
                  onClick={() => setSelectedModelId(model.id)}
                >
                  <span>
                    <strong>{model.displayName}</strong>
                    <small>{model.backend} · {model.quality} · {model.version}</small>
                  </span>
                  {model.installed ? <CheckCircle2 aria-label="Installed" /> : <X aria-label="Missing" />}
                </button>
              ))}
            </div>
          </section>

          <section className="panel export-panel">
            <div className="panel-heading">
              <Download aria-hidden />
              <h2>Export</h2>
            </div>
            <button
              className="primary-action"
              type="button"
              onClick={exportSelectedStems}
              disabled={!project || project.stems.length === 0}
            >
              <Download aria-hidden />
              Export selected
            </button>
            <button className="secondary-action" type="button" onClick={revealCurrentProject}>
              <FolderOpen aria-hidden />
              Open project folder
            </button>
            <p className="export-count">
              {selectedStemIds.length || 0} of {project?.stems.length ?? 0} stems selected
            </p>
          </section>

          <section className="panel details-panel">
            <div className="panel-heading">
              <AlertTriangle aria-hidden />
              <h2>Session</h2>
            </div>
            <dl>
              <div>
                <dt>Projects</dt>
                <dd>{boot?.projectRoot ?? "Loading"}</dd>
              </div>
              <div>
                <dt>Registry</dt>
                <dd>{boot?.modelRegistryPath ?? "Loading"}</dd>
              </div>
              <div>
                <dt>Latest job</dt>
                <dd>{latestJob ? latestJob.state : "None"}</dd>
              </div>
            </dl>
            {logEntries.length > 0 ? (
              <ul className="log-list">
                {logEntries.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  );
}

function StemPreview({
  stem,
  state,
  soloActive,
  selected,
  onSelect,
  onUpdate,
}: {
  stem: StemFile;
  state: PreviewState;
  soloActive: boolean;
  selected: boolean;
  onSelect: () => void;
  onUpdate: (patch: Partial<PreviewState>) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isAudible = !state.muted && (!soloActive || state.solo);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = state.volume;
    }
  }, [state.volume]);

  return (
    <article className="stem-row">
      <label className="stem-select">
        <input type="checkbox" checked={selected} onChange={onSelect} />
        <span>{stem.label}</span>
      </label>
      <audio ref={audioRef} controls muted={!isAudible} src={convertFileSrc(stem.path)} />
      <div className="stem-controls">
        <button
          className={state.solo ? "toggle is-on" : "toggle"}
          type="button"
          onClick={() => onUpdate({ solo: !state.solo })}
        >
          Solo
        </button>
        <button
          className={state.muted ? "toggle is-on" : "toggle"}
          type="button"
          onClick={() => onUpdate({ muted: !state.muted })}
        >
          Mute
        </button>
        <input
          aria-label={`${stem.label} volume`}
          max="1"
          min="0"
          onChange={(event) => onUpdate({ volume: Number(event.currentTarget.value) })}
          step="0.01"
          type="range"
          value={state.volume}
        />
      </div>
    </article>
  );
}

function StateBadge({ state }: { state: JobState }) {
  return <span className={`state-badge state-${state}`}>{state.replace("_", " ")}</span>;
}

function formatTask(value: TaskType) {
  return TASKS.find((task) => task.value === value)?.label ?? value;
}

export default App;
