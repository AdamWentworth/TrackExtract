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

type CommandArgs = Record<string, unknown> | undefined;

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
const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function command<T>(name: string, args?: CommandArgs): Promise<T> {
  if (isTauriRuntime()) {
    return invoke<T>(name, args);
  }

  return mockCommand<T>(name, args);
}

async function listenTo<T>(
  eventName: string,
  handler: Parameters<typeof listen<T>>[1],
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  return listen<T>(eventName, handler);
}

function audioSrc(path: string) {
  return isTauriRuntime() ? convertFileSrc(path) : mockPreviewAudioUrl(path);
}

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
      const imported = await command<ProjectSession>("import_audio_files", { paths });
      setProject(imported);
      setSelectedSourceId(imported.originalFiles[0]?.id ?? "");
      setSelectedStemIds([]);
      setPreviewState({});
      setStatus(`Imported ${imported.originalFiles.length} file${imported.originalFiles.length === 1 ? "" : "s"}`);
      const refreshedJobs = await command<JobRecord[]>("get_jobs");
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
        const snapshot = await command<BootstrapState>("bootstrap_app");
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
      const unlistenProgress = await listenTo<BackendProgress>("job_progress", (event) => {
        setStatus(event.payload.message);
      });
      const unlistenJob = await listenTo<JobRecord>("job_state_changed", (event) => {
        mergeJob(event.payload);
      });
      const unlistenProject = await listenTo<ProjectSession>("project_updated", (event) => {
        setProject(event.payload);
      });
      const unlistenLog = await listenTo<string>("log_entry", (event) => {
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

    if (isTauriRuntime()) {
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
    } else {
      const preventBrowserNavigation = (event: DragEvent) => {
        event.preventDefault();
      };

      window.addEventListener("dragover", preventBrowserNavigation);
      window.addEventListener("drop", preventBrowserNavigation);

      unlistenDragDrop = () => {
        window.removeEventListener("dragover", preventBrowserNavigation);
        window.removeEventListener("drop", preventBrowserNavigation);
      };
    }

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
    if (!isTauriRuntime()) {
      await importAudioPaths(["/mock/Artist - Browser Demo.wav"]);
      return;
    }

    const selected = await open({
      multiple: true,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });

    if (!selected) {
      return;
    }

    await importAudioPaths(Array.isArray(selected) ? selected : [selected]);
  }

  async function handleDropZoneDrop(event: React.DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (isTauriRuntime()) {
      return;
    }

    const files = Array.from(event.dataTransfer.files);
    const mockPaths = files.length > 0
      ? files.map((file) => `/mock/${file.name}`)
      : ["/mock/Artist - Browser Demo.wav"];
    await importAudioPaths(mockPaths);
  }

  async function refreshModels() {
    const refreshed = await command<ModelEntry[]>("list_models");
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
      const queued = await command<JobRecord>("enqueue_separation", {
        task,
        modelId: selectedModel.id,
        sourceId: selectedSourceId || null,
      });
      mergeJob(queued);
      const completed = await command<JobRecord>("start_job", { jobId: queued.id });
      mergeJob(completed);
      const refreshedProject = await command<ProjectSession | null>("get_project");
      if (refreshedProject) {
        setProject(refreshedProject);
      }
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

    const cancelled = await command<JobRecord>("cancel_job", { jobId: runningJob.id });
    mergeJob(cancelled);
    setStatus("Cancellation requested");
  }

  async function exportSelectedStems() {
    if (!project || project.stems.length === 0) {
      return;
    }

    const destination = isTauriRuntime()
      ? await open({ directory: true, multiple: false })
      : "/mock/export";
    if (!destination || Array.isArray(destination)) {
      return;
    }

    try {
      const exported = await command<string[]>("export_stems", {
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
      await command("reveal_path", { path: project.rootPath });
    } else if (boot) {
      await command("reveal_path", { path: boot.projectRoot });
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
            <button
              className="drop-zone"
              type="button"
              onClick={chooseFiles}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDropZoneDrop}
              disabled={isBusy}
            >
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
      <audio ref={audioRef} controls muted={!isAudible} src={audioSrc(stem.path)} />
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

const mockModels: ModelEntry[] = [
  {
    id: "stub_vocals_instrumental",
    displayName: "Stub Vocals / Instrumental",
    backend: "stub",
    tasks: ["vocals_instrumental"],
    stems: ["Vocals", "Instrumental"],
    sampleRate: 44100,
    quality: "development",
    version: "0.1.0",
    installed: true,
    path: "",
    downloadUrl: "",
  },
  {
    id: "stub_full_stem_split",
    displayName: "Stub Full Stem Split",
    backend: "stub",
    tasks: ["full_stem_split"],
    stems: ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"],
    sampleRate: 44100,
    quality: "development",
    version: "0.1.0",
    installed: true,
    path: "",
    downloadUrl: "",
  },
  {
    id: "onnx_roformer_full_split_placeholder",
    displayName: "RoFormer Full Stem Split",
    backend: "onnx",
    tasks: ["full_stem_split", "experimental_best_quality"],
    stems: ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"],
    sampleRate: 44100,
    quality: "best",
    version: "placeholder",
    installed: false,
    path: "",
    downloadUrl: "",
  },
];

let mockProject: ProjectSession | null = null;
let mockJobs: JobRecord[] = [];

async function mockCommand<T>(name: string, args?: CommandArgs): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, name === "start_job" ? 450 : 80));

  switch (name) {
    case "bootstrap_app":
      return {
        projectRoot: "/mock/TrackExtract Projects",
        appDataDir: "/mock/TrackExtract App Data",
        modelRegistryPath: "/mock/TrackExtract App Data/models.json",
        models: mockModels,
        currentProject: mockProject,
        jobs: mockJobs,
      } as T;

    case "list_models":
      return mockModels as T;

    case "import_audio_files":
      mockProject = createMockProject((args?.paths as string[] | undefined) ?? []);
      mockJobs = [];
      return mockProject as T;

    case "enqueue_separation": {
      if (!mockProject) {
        throw new Error("Import mock audio before queueing a separation.");
      }

      const task = args?.task as TaskType;
      const modelId = args?.modelId as string | null | undefined;
      const model =
        mockModels.find((candidate) => candidate.id === modelId) ??
        mockModels.find((candidate) => candidate.installed && candidate.tasks.includes(task));

      if (!model?.installed) {
        throw new Error(`${model?.displayName ?? "Selected model"} is not installed.`);
      }

      const job = createMockJob(mockProject, task, model.id);
      mockJobs = [job, ...mockJobs];
      mockProject.jobs = [job.id, ...mockProject.jobs];
      return job as T;
    }

    case "start_job": {
      const jobId = args?.jobId as string;
      const job = mockJobs.find((candidate) => candidate.id === jobId);
      if (!job || !mockProject) {
        throw new Error("Mock job was not found.");
      }

      const model = mockModels.find((candidate) => candidate.id === job.modelId);
      const stems =
        model?.stems.map((label) => ({
          id: mockId("stem"),
          label,
          path: `${mockProject?.rootPath}/stems/${mockProject?.name} - ${label}.wav`,
          sourceJobId: job.id,
          muted: false,
          solo: false,
          volume: 1,
        })) ?? [];

      const completed = {
        ...job,
        state: "complete" as JobState,
        progress: 1,
        statusMessage: "Mock separation complete",
        stems,
        logPath: `${mockProject.rootPath}/logs/${job.id}.log`,
        updatedAt: new Date().toISOString(),
      };

      mockJobs = mockJobs.map((candidate) => (candidate.id === job.id ? completed : candidate));
      mockProject = {
        ...mockProject,
        stems,
        updatedAt: new Date().toISOString(),
      };
      return completed as T;
    }

    case "cancel_job": {
      const jobId = args?.jobId as string;
      const cancelled = mockJobs.find((candidate) => candidate.id === jobId);
      if (!cancelled) {
        throw new Error("Mock job was not found.");
      }
      const next = {
        ...cancelled,
        state: "cancelled" as JobState,
        statusMessage: "Cancelled",
        updatedAt: new Date().toISOString(),
      };
      mockJobs = mockJobs.map((candidate) => (candidate.id === jobId ? next : candidate));
      return next as T;
    }

    case "get_project":
      return mockProject as T;

    case "get_jobs":
      return mockJobs as T;

    case "export_stems": {
      const destinationPath = (args?.destinationPath as string | undefined) ?? "/mock/export";
      const exported = (mockProject?.stems ?? []).map(
        (stem) => `${destinationPath}/${lastPathPart(stem.path) ?? `${stem.label}.wav`}`,
      );
      return exported as T;
    }

    case "reveal_path":
      return undefined as T;

    default:
      throw new Error(`No browser mock exists for ${name}.`);
  }
}

function createMockProject(paths: string[]): ProjectSession {
  const sourcePaths = paths.length > 0 ? paths : ["/mock/Artist - Browser Demo.wav"];
  const firstName = lastPathPart(sourcePaths[0] ?? "")?.replace(/\.[^.]+$/, "") ?? "Browser Demo";
  const now = new Date().toISOString();
  const rootPath = `/mock/TrackExtract Projects/${firstName}`;

  return {
    schemaVersion: 1,
    id: mockId("project"),
    name: firstName,
    rootPath,
    createdAt: now,
    updatedAt: now,
    originalFiles: sourcePaths.map((path) => {
      const originalName = lastPathPart(path) ?? "audio.wav";
      return {
        id: mockId("source"),
        originalName,
        sourcePath: path,
        projectPath: `${rootPath}/original/${originalName}`,
        sampleRate: 44100,
        channels: 2,
        durationSeconds: 184,
      };
    }),
    jobs: [],
    stems: [],
  };
}

function createMockJob(project: ProjectSession, task: TaskType, modelId: string): JobRecord {
  const now = new Date().toISOString();
  const source = project.originalFiles[0];

  return {
    id: mockId("job"),
    projectId: project.id,
    projectName: project.name,
    sourceId: source?.id ?? mockId("source"),
    sourcePath: source?.projectPath ?? `${project.rootPath}/original/mock.wav`,
    task,
    modelId,
    state: "queued",
    progress: 0,
    statusMessage: "Queued in browser mock mode",
    error: null,
    stems: [],
    logPath: null,
    createdAt: now,
    updatedAt: now,
  };
}

function mockId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function lastPathPart(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

const mockPreviewUrls = new Map<string, string>();

function mockPreviewAudioUrl(path: string) {
  if (mockPreviewUrls.has(path)) {
    return mockPreviewUrls.get(path) ?? SILENT_WAV_DATA_URI;
  }

  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return SILENT_WAV_DATA_URI;
  }

  const sampleRate = 44_100;
  const durationSeconds = 0.35;
  const frames = Math.floor(sampleRate * durationSeconds);
  const channels = 1;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  let offset = 0;
  const pitch = 220 + (hashString(path) % 440);

  const writeString = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index));
      offset += 1;
    }
  };
  const writeU16 = (value: number) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const writeU32 = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };

  writeString("RIFF");
  writeU32(36 + dataBytes);
  writeString("WAVE");
  writeString("fmt ");
  writeU32(16);
  writeU16(1);
  writeU16(channels);
  writeU32(sampleRate);
  writeU32(sampleRate * channels * bytesPerSample);
  writeU16(channels * bytesPerSample);
  writeU16(16);
  writeString("data");
  writeU32(dataBytes);

  for (let frame = 0; frame < frames; frame += 1) {
    const envelope = Math.sin(Math.PI * frame / frames);
    const sample =
      Math.sin(2 * Math.PI * pitch * frame / sampleRate) * envelope * 0.18;
    view.setInt16(offset, Math.round(sample * i16Max()), true);
    offset += 2;
  }

  const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  mockPreviewUrls.set(path, url);
  return url;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function i16Max() {
  return 32767;
}

export default App;
