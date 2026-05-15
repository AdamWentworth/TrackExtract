import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import bundledModels from "../resources/models.json";
import bundledWorkflows from "../resources/workflows.json";
import logoRow from "./assets/brand/trackextract-logo-row.png";
import logoRowWhite from "./assets/brand/trackextract-logo-row-white.png";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  ExternalLink,
  FolderOpen,
  ListMusic,
  Moon,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Square,
  Sun,
  Trash2,
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
  | "experimental_best_quality"
  | "vocal_cleanup_chain"
  | "layered_vocal_cleanup"
  | "vocal_dereverb"
  | "vocal_denoise";

type JobState = "queued" | "preparing" | "running" | "complete" | "failed" | "cancelled";

type BackendKind = "stub" | "onnx" | "pytorch-worker" | "external-process" | "python-engine";
type InstallMethod = "direct-url" | "audio-separator" | "source-only";
type RuntimeProvider = "demucs" | "audio-separator" | "stub" | "";
type ModelOptionType = "select" | "integer" | "number" | "boolean";
type RenderOptionValue = string | number | boolean;
type WorkflowKind = "preset" | "custom" | "template";
type ModelStatusFilter = "all" | "runnable" | "installable" | "pending" | "missing";
type ModelStatusKey = Exclude<ModelStatusFilter, "all">;
type ModelTaskFilter = "all" | TaskType;
type ModelBackendFilter = "all" | BackendKind;
type ThemeMode = "dark" | "light";
type ExportFormat = "wav" | "flac" | "mp3" | "m4a" | "aiff";

interface ModelOptionChoice {
  value: string;
  label: string;
}

interface ModelOptionDefinition {
  id: string;
  displayName: string;
  type: ModelOptionType;
  defaultValue: RenderOptionValue;
  description?: string;
  choices?: ModelOptionChoice[];
  min?: number;
  max?: number;
  step?: number;
}

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
  sourceUrl?: string;
  license?: string;
  notes?: string;
  downloadSizeMb?: number;
  installMethod?: InstallMethod;
  runtime?: {
    provider?: RuntimeProvider;
    modelFilename?: string;
    workerScript?: string;
    demucsModel?: string;
    demucsMode?: string;
    device?: string;
  };
  options?: ModelOptionDefinition[];
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

interface WorkflowStep {
  id: string;
  displayName: string;
  task: TaskType;
  modelId: string;
  inputStem?: string;
  outputStems?: string[];
  options: Record<string, RenderOptionValue>;
}

interface WorkflowEntry {
  id: string;
  displayName: string;
  description: string;
  kind: WorkflowKind;
  task: TaskType;
  steps: WorkflowStep[];
}

interface JobRecord {
  id: string;
  projectId: string;
  projectName: string;
  sourceId: string;
  sourcePath: string;
  task: TaskType;
  modelId: string;
  options: Record<string, RenderOptionValue>;
  state: JobState;
  progress: number;
  statusMessage: string;
  error: string | null;
  stems: StemFile[];
  logPath: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowStepReadinessIssue {
  step: WorkflowStep;
  model: ModelEntry | null;
  message: string;
}

interface BootstrapState {
  projectRoot: string;
  appDataDir: string;
  modelRegistryPath: string;
  workflowRegistryPath: string;
  models: ModelEntry[];
  workflows: WorkflowEntry[];
  currentProject: ProjectSession | null;
  jobs: JobRecord[];
}

interface BackendProgress {
  jobId: string;
  progress: number;
  message: string;
}

interface ModelDownloadProgress {
  modelId: string;
  progress: number;
  bytesDownloaded: number;
  totalBytes: number | null;
  message: string;
}

interface PreviewState {
  muted: boolean;
  solo: boolean;
  volume: number;
}

interface WaveformData {
  durationSeconds: number;
  peaks: number[];
}

interface ScrollMetrics {
  progress: number;
  thumbRatio: number;
  visible: boolean;
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
  { value: "vocal_cleanup_chain", label: "Clean Lead Vocal", short: "Chain" },
  { value: "layered_vocal_cleanup", label: "Remove Layered Vocals", short: "Karaoke" },
  { value: "vocal_dereverb", label: "Dereverb Vocal", short: "Dry" },
  { value: "vocal_denoise", label: "Denoise Vocal", short: "Clean" },
];

const AUDIO_EXTENSIONS = ["wav", "aiff", "aif", "flac", "mp3", "m4a"];
const EXPORT_FORMATS: Array<{ value: ExportFormat; label: string; description: string }> = [
  { value: "wav", label: "WAV", description: "DAW-ready lossless" },
  { value: "flac", label: "FLAC", description: "Lossless compressed" },
  { value: "mp3", label: "MP3", description: "320 kbps sharing" },
  { value: "m4a", label: "M4A", description: "AAC compressed" },
  { value: "aiff", label: "AIFF", description: "Apple DAW lossless" },
];
const SILENT_WAV_DATA_URI = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
const THEME_STORAGE_KEY = "trackextract_theme";
const WAVEFORM_PEAK_COUNT = 192;
const DEV_BRIDGE_PREFIX = "/__trackextract_dev";
const DEV_BRIDGE_COMMANDS = new Set([
  "bootstrap_app",
  "import_audio_files",
  "list_models",
  "list_workflows",
  "save_custom_workflow",
  "install_model",
  "enqueue_separation",
  "start_job",
  "cancel_job",
  "get_project",
  "get_jobs",
  "clear_jobs",
  "export_stems",
  "clear_project_stems",
  "clear_project_source",
  "sync_audio_separator_catalog",
  "stem_media_url",
  "reveal_path",
]);
const MODEL_STATUS_FILTERS: Array<{ value: ModelStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "runnable", label: "Runnable" },
  { value: "installable", label: "Installable" },
  { value: "pending", label: "Needs definition" },
  { value: "missing", label: "Catalog only" },
];
const MODEL_BACKEND_FILTERS: Array<{ value: ModelBackendFilter; label: string }> = [
  { value: "all", label: "All backends" },
  { value: "pytorch-worker", label: "PyTorch worker" },
  { value: "python-engine", label: "Python engine" },
  { value: "onnx", label: "ONNX" },
  { value: "external-process", label: "External process" },
  { value: "stub", label: "Stub" },
];

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isDevBridgeRuntime() {
  return (
    typeof window !== "undefined" && window.location.protocol.startsWith("http") && window.location.port === "1420"
  );
}

async function command<T>(name: string, args?: CommandArgs): Promise<T> {
  if (name === "reveal_path" && isTauriRuntime()) {
    return invoke<T>(name, args);
  }

  if (isDevBridgeRuntime() && DEV_BRIDGE_COMMANDS.has(name)) {
    return devBridgeCommand<T>(name, args);
  }

  if (isTauriRuntime()) {
    return invoke<T>(name, args);
  }

  return mockCommand<T>(name, args);
}

async function devBridgeCommand<T>(name: string, args?: CommandArgs): Promise<T> {
  const response = await fetch(`${DEV_BRIDGE_PREFIX}/command`, {
    body: JSON.stringify({ command: name, args: args ?? {} }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const envelope = (await response.json().catch(() => null)) as { ok?: boolean; payload?: T; message?: string } | null;
  if (!response.ok || !envelope?.ok) {
    throw new Error(envelope?.message ?? `Track Extract dev bridge failed: ${name}`);
  }
  return envelope.payload as T;
}

async function uploadBrowserAudioFiles(files: File[]): Promise<ProjectSession> {
  const body = new FormData();
  for (const file of files) {
    body.append("files", file, file.name);
  }

  const response = await fetch(`${DEV_BRIDGE_PREFIX}/import-files`, {
    body,
    method: "POST",
  });
  const envelope = (await response.json().catch(() => null)) as {
    ok?: boolean;
    payload?: ProjectSession;
    message?: string;
  } | null;
  if (!response.ok || !envelope?.ok || !envelope.payload) {
    throw new Error(envelope?.message ?? "Browser import failed.");
  }
  return envelope.payload;
}

async function listenTo<T>(eventName: string, handler: Parameters<typeof listen<T>>[1]): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  return listen<T>(eventName, handler);
}

function browserStemMediaSrc(path: string) {
  return mockPreviewAudioUrl(path);
}

function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") {
      return "dark";
    }
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  });
  const [boot, setBoot] = useState<BootstrapState | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([]);
  const [project, setProject] = useState<ProjectSession | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [task, setTask] = useState<TaskType>("vocals_instrumental");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [selectedStemIds, setSelectedStemIds] = useState<string[]>([]);
  const [renderOptions, setRenderOptions] = useState<Record<string, RenderOptionValue>>({});
  const [previewState, setPreviewState] = useState<Record<string, PreviewState>>({});
  const [sourceMediaUrls, setSourceMediaUrls] = useState<Record<string, string>>({});
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [exportFormat, setExportFormat] = useState<ExportFormat>("wav");
  const [modelInstallProgress, setModelInstallProgress] = useState<Record<string, ModelDownloadProgress>>({});
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [modelStatusFilter, setModelStatusFilter] = useState<ModelStatusFilter>("all");
  const [modelTaskFilter, setModelTaskFilter] = useState<ModelTaskFilter>("all");
  const [modelBackendFilter, setModelBackendFilter] = useState<ModelBackendFilter>("all");
  const [customWorkflowName, setCustomWorkflowName] = useState("");
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [logEntries, setLogEntries] = useState<string[]>([]);
  const leftRailRef = useRef<HTMLElement | null>(null);
  const mainColumnRef = useRef<HTMLElement | null>(null);
  const rightRailRef = useRef<HTMLElement | null>(null);
  const detailsPanelRef = useRef<HTMLElement | null>(null);
  const leftRailScrollbar = useScrollMetrics(leftRailRef);
  const mainColumnScrollbar = useScrollMetrics(mainColumnRef);
  const rightRailScrollbar = useScrollMetrics(rightRailRef);
  const detailsPanelScrollbar = useScrollMetrics(detailsPanelRef);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = themeMode;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    }
  }, [themeMode]);

  const mergeJob = useCallback((updated: JobRecord) => {
    setJobs((existing) => {
      const found = existing.some((job) => job.id === updated.id);
      if (!found) {
        return [updated, ...existing];
      }
      return existing.map((job) => (job.id === updated.id ? updated : job));
    });
  }, []);

  const applyProjectSnapshot = useCallback((snapshot: ProjectSession | null) => {
    setProject(snapshot);
    setSelectedSourceId((current) => {
      if (!snapshot || snapshot.originalFiles.length === 0) {
        return "";
      }
      return snapshot.originalFiles.some((source) => source.id === current) ? current : snapshot.originalFiles[0].id;
    });
  }, []);

  const importAudioPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        return;
      }

      setIsBusy(true);
      setError(null);
      setStatus("Creating project session");

      try {
        const imported = await command<ProjectSession>("import_audio_files", { paths });
        applyProjectSnapshot(imported);
        setSelectedStemIds([]);
        setPreviewState({});
        setSourceMediaUrls({});
        setMediaUrls({});
        setStatus(`Imported ${imported.originalFiles.length} file${imported.originalFiles.length === 1 ? "" : "s"}`);
        const refreshedJobs = await command<JobRecord[]>("get_jobs");
        setJobs(refreshedJobs);
      } catch (caught) {
        setError(String(caught));
        setStatus("Import failed");
      } finally {
        setIsBusy(false);
      }
    },
    [applyProjectSnapshot],
  );

  useEffect(() => {
    let cleanup = () => {};

    async function bootstrap() {
      try {
        const snapshot = await command<BootstrapState>("bootstrap_app");
        setBoot(snapshot);
        setModels(snapshot.models);
        setWorkflows(snapshot.workflows);
        setSelectedWorkflowId(snapshot.workflows[0]?.id ?? "");
        applyProjectSnapshot(snapshot.currentProject);
        setJobs(snapshot.jobs);
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
        applyProjectSnapshot(event.payload);
      });
      const unlistenLog = await listenTo<string>("log_entry", (event) => {
        setLogEntries((entries) => [event.payload, ...entries].slice(0, 6));
      });
      const unlistenModelProgress = await listenTo<ModelDownloadProgress>("model_download_progress", (event) => {
        setModelInstallProgress((existing) => ({
          ...existing,
          [event.payload.modelId]: event.payload,
        }));
        setStatus(event.payload.message);
      });
      const unlistenModelsUpdated = await listenTo<ModelEntry[]>("models_updated", (event) => {
        setModels(event.payload);
      });
      const unlistenWorkflowsUpdated = await listenTo<WorkflowEntry[]>("workflows_updated", (event) => {
        setWorkflows(event.payload);
      });
      const unlistenJobsUpdated = await listenTo<JobRecord[]>("jobs_updated", (event) => {
        setJobs(event.payload);
      });

      cleanup = () => {
        unlistenProgress();
        unlistenJob();
        unlistenProject();
        unlistenLog();
        unlistenModelProgress();
        unlistenModelsUpdated();
        unlistenWorkflowsUpdated();
        unlistenJobsUpdated();
      };
    }

    bootstrap();
    bindEvents();

    return () => cleanup();
  }, [applyProjectSnapshot, mergeJob]);

  useEffect(() => {
    if (!boot) {
      return;
    }

    let cancelled = false;
    let tick = 0;
    async function refreshSharedState() {
      try {
        const includeRegistries = tick % 5 === 0;
        tick += 1;
        const [latestProject, latestJobs, latestModels, latestWorkflows] = await Promise.all([
          command<ProjectSession | null>("get_project"),
          command<JobRecord[]>("get_jobs"),
          includeRegistries ? command<ModelEntry[]>("list_models") : Promise.resolve(null),
          includeRegistries ? command<WorkflowEntry[]>("list_workflows") : Promise.resolve(null),
        ]);
        if (!cancelled) {
          applyProjectSnapshot(latestProject);
          setJobs(latestJobs);
          const activeJob = latestJobs.find((job) => job.state === "running" || job.state === "preparing");
          if (activeJob) {
            setStatus(activeJob.statusMessage);
          }
          if (latestModels) {
            setModels(latestModels);
          }
          if (latestWorkflows) {
            setWorkflows(latestWorkflows);
          }
        }
      } catch {
        // Polling is opportunistic; direct commands still surface user-readable errors.
      }
    }

    const interval = window.setInterval(refreshSharedState, isDevBridgeRuntime() ? 1000 : 1800);
    window.addEventListener("focus", refreshSharedState);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshSharedState);
    };
  }, [applyProjectSnapshot, boot]);

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
    const preferred =
      compatible.find((model) => model.installed && model.backend !== "stub") ??
      compatible.find((model) => model.installed) ??
      compatible[0];
    const selected = compatible.find((model) => model.id === selectedModelId);

    if (preferred && (!selected || (selected.backend === "stub" && preferred.backend !== "stub"))) {
      setSelectedModelId(preferred.id);
    }
  }, [models, selectedModelId, task]);

  useEffect(() => {
    if (!project) {
      setSourceMediaUrls({});
      setMediaUrls({});
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

    setSourceMediaUrls((existing) => {
      const ids = new Set(project.originalFiles.map((source) => source.id));
      return Object.fromEntries(Object.entries(existing).filter(([id]) => ids.has(id)));
    });

    setMediaUrls((existing) => {
      const ids = new Set(project.stems.map((stem) => stem.id));
      return Object.fromEntries(Object.entries(existing).filter(([id]) => ids.has(id)));
    });
  }, [project]);

  useEffect(() => {
    if (!project) {
      return;
    }

    if (!isTauriRuntime() && !isDevBridgeRuntime()) {
      setSourceMediaUrls((existing) => {
        const next = Object.fromEntries(
          project.originalFiles.map((source) => [
            source.id,
            existing[source.id] ?? browserStemMediaSrc(source.projectPath || source.sourcePath),
          ]),
        );
        return Object.keys(next).every((id) => next[id] === existing[id]) &&
          Object.keys(existing).length === Object.keys(next).length
          ? existing
          : next;
      });

      setMediaUrls((existing) => {
        const next = Object.fromEntries(
          project.stems.map((stem) => [stem.id, existing[stem.id] ?? browserStemMediaSrc(stem.path)]),
        );
        return Object.keys(next).every((id) => next[id] === existing[id]) &&
          Object.keys(existing).length === Object.keys(next).length
          ? existing
          : next;
      });
      return;
    }

    let cancelled = false;
    for (const source of project.originalFiles) {
      if (sourceMediaUrls[source.id]) {
        continue;
      }

      command<string>("stem_media_url", { path: source.projectPath || source.sourcePath })
        .then((url) => {
          if (!cancelled) {
            setSourceMediaUrls((existing) => ({ ...existing, [source.id]: url }));
          }
        })
        .catch((caught) => {
          if (!cancelled) {
            setError(String(caught));
          }
        });
    }

    for (const stem of project.stems) {
      if (mediaUrls[stem.id]) {
        continue;
      }

      command<string>("stem_media_url", { path: stem.path })
        .then((url) => {
          if (!cancelled) {
            setMediaUrls((existing) => ({ ...existing, [stem.id]: url }));
          }
        })
        .catch((caught) => {
          if (!cancelled) {
            setError(String(caught));
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [project, mediaUrls, sourceMediaUrls]);

  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId);
  const selectedWorkflowStep = selectedWorkflow?.steps[0];
  const compatibleModels = useMemo(() => models.filter((model) => model.tasks.includes(task)), [models, task]);
  const selectedModel = compatibleModels.find((model) => model.id === selectedModelId);
  const selectedModelOptions = selectedModel?.options ?? [];
  const runningJob = jobs.find((job) => job.state === "running" || job.state === "preparing");
  const latestJob = jobs[0];
  const selectedSource =
    project?.originalFiles.find((source) => source.id === selectedSourceId) ?? project?.originalFiles[0];
  const soloActive = Object.values(previewState).some((state) => state.solo);
  const selectedModelRunnable = selectedModel ? isRunnableModel(selectedModel) : false;
  const filteredModels = useMemo(() => {
    const query = modelFilter.trim().toLowerCase();
    return models
      .filter((model) => modelMatchesFilters(model, query, modelStatusFilter, modelTaskFilter, modelBackendFilter))
      .sort(compareModelsForLibrary);
  }, [modelBackendFilter, modelFilter, modelStatusFilter, modelTaskFilter, models]);
  const modelCounts = useMemo(
    () => ({
      total: models.length,
      runnable: models.filter(isRunnableModel).length,
      installable: models.filter(isInstallableModel).length,
      pending: models.filter((model) => model.installed && !isRunnableModel(model)).length,
      missing: models.filter((model) => modelStatusKey(model) === "missing").length,
    }),
    [models],
  );
  const workflowIssues = selectedWorkflow ? workflowStepReadinessIssues(selectedWorkflow, models) : [];
  const workflowInstallTargets = selectedWorkflow ? workflowInstallableModels(selectedWorkflow, models) : [];
  const workflowCanRun =
    selectedWorkflow && selectedWorkflow.steps.length > 1 ? workflowIssues.length === 0 : selectedModelRunnable;
  const workflowInstallBusy = workflowInstallTargets.some((model) => modelInstallProgress[model.id]);

  useEffect(() => {
    if (!selectedWorkflowStep) {
      return;
    }

    setTask(selectedWorkflowStep.task);
    setSelectedModelId(selectedWorkflowStep.modelId);
  }, [selectedWorkflowStep]);

  useEffect(() => {
    setRenderOptions(
      selectedModel
        ? {
            ...defaultRenderOptions(selectedModel),
            ...(selectedWorkflowStep?.modelId === selectedModel.id ? selectedWorkflowStep.options : {}),
          }
        : {},
    );
  }, [selectedModel, selectedWorkflowStep]);

  async function chooseFiles() {
    if (!isTauriRuntime()) {
      if (isDevBridgeRuntime()) {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = AUDIO_EXTENSIONS.map((extension) => `.${extension}`).join(",");
        input.onchange = () => {
          void importBrowserDroppedFiles(Array.from(input.files ?? []));
        };
        input.click();
        return;
      }
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
    if (isDevBridgeRuntime()) {
      await importBrowserDroppedFiles(files);
      return;
    }

    const mockPaths =
      files.length > 0 ? files.map((file) => `/mock/${file.name}`) : ["/mock/Artist - Browser Demo.wav"];
    await importAudioPaths(mockPaths);
  }

  async function importBrowserDroppedFiles(files: File[]) {
    const audioFiles = files.filter((file) =>
      AUDIO_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(`.${extension}`)),
    );
    if (audioFiles.length === 0) {
      setError("Drop or choose at least one supported audio file.");
      setStatus("Import failed");
      return;
    }

    setIsBusy(true);
    setError(null);
    setStatus("Importing browser-selected audio");

    try {
      const imported = await uploadBrowserAudioFiles(audioFiles);
      applyProjectSnapshot(imported);
      setSelectedStemIds([]);
      setPreviewState({});
      setSourceMediaUrls({});
      setMediaUrls({});
      setStatus(`Imported ${imported.originalFiles.length} file${imported.originalFiles.length === 1 ? "" : "s"}`);
      const refreshedJobs = await command<JobRecord[]>("get_jobs");
      setJobs(refreshedJobs);
    } catch (caught) {
      setError(String(caught));
      setStatus("Import failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshModels() {
    const refreshed = await command<ModelEntry[]>("list_models");
    setModels(refreshed);
    setStatus("Model registry refreshed");
  }

  async function syncAudioSeparatorCatalog() {
    setStatus("Syncing audio-separator catalog");
    setError(null);
    try {
      const refreshed = await command<ModelEntry[]>("sync_audio_separator_catalog");
      setModels(refreshed);
      setStatus("audio-separator catalog synced");
    } catch (caught) {
      setError(String(caught));
      setStatus("Catalog sync failed");
    }
  }

  async function refreshWorkflows() {
    const refreshed = await command<WorkflowEntry[]>("list_workflows");
    setWorkflows(refreshed);
    setStatus("Workflow registry refreshed");
  }

  async function runSeparation() {
    if (!project || !selectedSource || !selectedModel) {
      setError("Import an audio file and choose a runnable model first.");
      return;
    }

    if (selectedWorkflow && selectedWorkflow.steps.length > 1) {
      await runWorkflowSequence(selectedWorkflow);
      return;
    }

    if (!selectedModel.installed) {
      setError(`${selectedModel.displayName} is not installed yet.`);
      return;
    }

    if (!isRunnableModel(selectedModel)) {
      setError(`${selectedModel.displayName} is installed, but this model asset is not runnable in Track Extract yet.`);
      return;
    }

    setIsBusy(true);
    setError(null);
    setStatus("Queueing workflow job");

    let queuedJobId: string | null = null;
    try {
      const queued =
        jobs.find(
          (job) =>
            job.state === "queued" &&
            job.sourceId === selectedSource.id &&
            job.task === task &&
            job.modelId === selectedModel.id,
        ) ??
        (await command<JobRecord>("enqueue_separation", {
          task,
          modelId: selectedModel.id,
          sourceId: selectedSourceId || null,
          options: renderOptions,
        }));
      queuedJobId = queued.id;
      mergeJob(queued);
      setStatus(queued.state === "queued" ? "Starting queued job" : "Starting workflow job");
      const completed = await command<JobRecord>("start_job", { jobId: queued.id });
      mergeJob(completed);
      const refreshedProject = await command<ProjectSession | null>("get_project");
      if (refreshedProject) {
        applyProjectSnapshot(refreshedProject);
      }
      setStatus("Separation complete");
    } catch (caught) {
      const refreshedJobs = await command<JobRecord[]>("get_jobs").catch(() => jobs);
      setJobs(refreshedJobs);
      const cancelled = refreshedJobs.some((job) => job.id === queuedJobId && job.state === "cancelled");
      if (cancelled) {
        setStatus("Cancellation requested");
      } else {
        setError(String(caught));
        setStatus("Separation failed");
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function runWorkflowSequence(workflow: WorkflowEntry) {
    if (!project || !selectedSource) {
      setError("Import an audio file before running a workflow.");
      return;
    }

    const readinessIssue = workflowStepReadinessIssues(workflow, models)[0];
    if (readinessIssue) {
      setError(workflowStepIssueText(readinessIssue));
      return;
    }

    setIsBusy(true);
    setError(null);
    setStatus(`Starting ${workflow.displayName}`);

    let workingProject = project;
    let workingJobs = jobs;
    let sourceId = selectedSource.id;
    let previousJob: JobRecord | null = null;
    let queuedJobId: string | null = null;

    try {
      for (const [index, step] of workflow.steps.entries()) {
        const stepModel = models.find((candidate) => candidate.id === step.modelId);
        if (!stepModel) {
          throw new Error(`Workflow step "${step.displayName}" references a missing model.`);
        }

        if (step.inputStem) {
          const inputStem = findWorkflowInputStem(workingProject, step.inputStem, previousJob);
          if (!inputStem) {
            throw new Error(`Step "${step.displayName}" needs a "${step.inputStem}" stem from an earlier step.`);
          }
          sourceId = inputStem.id;
        } else if (index > 0 && previousJob?.stems[0]) {
          sourceId = previousJob.stems[0].id;
        }

        setTask(step.task);
        setSelectedModelId(step.modelId);
        setRenderOptions({ ...defaultRenderOptions(stepModel), ...step.options });
        setStatus(`Step ${index + 1}/${workflow.steps.length}: ${step.displayName}`);

        const queued =
          workingJobs.find(
            (job) =>
              job.state === "queued" &&
              job.sourceId === sourceId &&
              job.task === step.task &&
              job.modelId === step.modelId,
          ) ??
          (await command<JobRecord>("enqueue_separation", {
            task: step.task,
            modelId: step.modelId,
            sourceId,
            options: step.options,
          }));

        queuedJobId = queued.id;
        mergeJob(queued);
        workingJobs = [queued, ...workingJobs.filter((job) => job.id !== queued.id)];

        const completed = await command<JobRecord>("start_job", { jobId: queued.id });
        previousJob = completed;
        mergeJob(completed);
        workingJobs = workingJobs.map((job) => (job.id === completed.id ? completed : job));

        const refreshedProject = await command<ProjectSession | null>("get_project");
        if (!refreshedProject) {
          throw new Error("Workflow project disappeared before the next step could run.");
        }
        workingProject = refreshedProject;
        applyProjectSnapshot(refreshedProject);
      }

      const refreshedJobs = await command<JobRecord[]>("get_jobs");
      setJobs(refreshedJobs);
      setStatus(`Workflow complete: ${workflow.displayName}`);
    } catch (caught) {
      const refreshedJobs = await command<JobRecord[]>("get_jobs").catch(() => workingJobs);
      setJobs(refreshedJobs);
      const cancelled = refreshedJobs.some((job) => job.id === queuedJobId && job.state === "cancelled");
      if (cancelled) {
        setStatus("Cancellation requested");
      } else {
        setError(String(caught));
        setStatus("Workflow failed");
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function cancelRunningJob() {
    if (!runningJob) {
      return;
    }

    setError(null);
    setStatus("Cancelling job");

    try {
      const cancelled = await command<JobRecord>("cancel_job", { jobId: runningJob.id });
      mergeJob(cancelled);
      setStatus("Cancellation requested");
    } catch (caught) {
      setError(String(caught));
      setStatus("Cancel failed");
    }
  }

  async function clearJobHistory() {
    if (jobs.length === 0) {
      return;
    }

    const confirmed = window.confirm("Clear job history from this workspace? Stem files and source audio are kept.");
    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setStatus("Clearing job history");

    try {
      const clearedJobs = await command<JobRecord[]>("clear_jobs");
      setJobs(clearedJobs);
      const refreshedProject = await command<ProjectSession | null>("get_project");
      if (refreshedProject) {
        applyProjectSnapshot(refreshedProject);
      }
      setStatus("Job history cleared");
    } catch (caught) {
      setError(String(caught));
      setStatus("Could not clear jobs");
    } finally {
      setIsBusy(false);
    }
  }

  async function exportSelectedStems() {
    if (!project || project.stems.length === 0) {
      return;
    }

    const destination = isTauriRuntime()
      ? await open({ directory: true, multiple: false })
      : `${project.rootPath}/renders/exports`;
    if (!destination || Array.isArray(destination)) {
      return;
    }

    try {
      const exported = await command<string[]>("export_stems", {
        stemIds: selectedStemIds,
        destinationPath: destination,
        format: exportFormat,
      });
      setStatus(`Exported ${exported.length} ${exportFormat.toUpperCase()} stem${exported.length === 1 ? "" : "s"}`);
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

  async function clearGeneratedStems() {
    if (!project || project.stems.length === 0) {
      return;
    }

    const confirmed = window.confirm(
      "Clear generated stems from this workspace? This removes files in the stems folder.",
    );
    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setStatus("Clearing generated stems");

    try {
      const updated = await command<ProjectSession>("clear_project_stems");
      applyProjectSnapshot(updated);
      setSelectedStemIds([]);
      setPreviewState({});
      setMediaUrls({});
      const refreshedJobs = await command<JobRecord[]>("get_jobs");
      setJobs(refreshedJobs);
      setStatus("Generated stems cleared");
    } catch (caught) {
      setError(String(caught));
      setStatus("Could not clear stems");
    } finally {
      setIsBusy(false);
    }
  }

  async function clearSourceAudio() {
    if (!project || project.originalFiles.length === 0) {
      return;
    }

    const confirmed = window.confirm(
      "Clear the source audio from this workspace? This also clears generated stems and job history. Your original file outside Track Extract is not touched.",
    );
    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    setError(null);
    setStatus("Clearing source audio");

    try {
      const updated = await command<ProjectSession>("clear_project_source");
      applyProjectSnapshot(updated);
      setSelectedStemIds([]);
      setPreviewState({});
      setSourceMediaUrls({});
      setMediaUrls({});
      const refreshedJobs = await command<JobRecord[]>("get_jobs");
      setJobs(refreshedJobs);
      setStatus("Source audio cleared");
    } catch (caught) {
      setError(String(caught));
      setStatus("Could not clear source");
    } finally {
      setIsBusy(false);
    }
  }

  async function openModelSource(model: ModelEntry) {
    const url = model.sourceUrl || model.downloadUrl;
    if (!url) {
      return;
    }

    try {
      if (isTauriRuntime()) {
        await openUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function installModelEntry(model: ModelEntry) {
    setError(null);
    setStatus(`Installing ${model.displayName}`);
    setModelInstallProgress((existing) => ({
      ...existing,
      [model.id]: {
        modelId: model.id,
        progress: 0,
        bytesDownloaded: 0,
        totalBytes: model.downloadSizeMb ? model.downloadSizeMb * 1024 * 1024 : null,
        message: `Installing ${model.displayName}`,
      },
    }));

    try {
      const installed = await command<ModelEntry>("install_model", { modelId: model.id });
      setModels((existing) => existing.map((candidate) => (candidate.id === installed.id ? installed : candidate)));
      setStatus(`${installed.displayName} installed`);
      return installed;
    } catch (caught) {
      setError(String(caught));
      setStatus("Model install failed");
      return null;
    } finally {
      setModelInstallProgress((existing) => {
        const next = { ...existing };
        delete next[model.id];
        return next;
      });
    }
  }

  async function installModel(model: ModelEntry) {
    await installModelEntry(model);
  }

  async function installSelectedWorkflowModels() {
    if (!selectedWorkflow) {
      return;
    }

    const targets = workflowInstallableModels(selectedWorkflow, models);
    if (targets.length === 0) {
      const firstIssue = workflowStepReadinessIssues(selectedWorkflow, models)[0];
      setError(firstIssue ? workflowStepIssueText(firstIssue) : "This workflow has no installable missing models.");
      return;
    }

    setIsBusy(true);
    let installedCount = 0;
    try {
      for (const target of targets) {
        const installed = await installModelEntry(target);
        if (!installed) {
          return;
        }
        installedCount += 1;
      }

      const refreshed = await command<ModelEntry[]>("list_models").catch(() => null);
      if (refreshed) {
        setModels(refreshed);
      }
      setStatus(`Installed ${installedCount} workflow model${installedCount === 1 ? "" : "s"}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function saveCurrentWorkflow() {
    if (!selectedModel) {
      setError("Choose a model before saving a workflow.");
      return;
    }

    const displayName = customWorkflowName.trim();
    if (!displayName) {
      setError("Name the workflow before saving it.");
      return;
    }

    const workflow: WorkflowEntry = {
      id: `custom_${slugify(displayName)}_${Date.now().toString(36)}`,
      displayName,
      description: `Custom ${formatTask(task)} workflow.`,
      kind: "custom",
      task,
      steps: [
        {
          id: "step_1",
          displayName: formatTask(task),
          task,
          modelId: selectedModel.id,
          options: renderOptions,
        },
      ],
    };

    try {
      const saved = await command<WorkflowEntry>("save_custom_workflow", { workflow });
      const refreshed = await command<WorkflowEntry[]>("list_workflows");
      setWorkflows(refreshed);
      setSelectedWorkflowId(saved.id);
      setCustomWorkflowName("");
      setStatus(`Saved workflow ${saved.displayName}`);
    } catch (caught) {
      setError(String(caught));
      setStatus("Workflow save failed");
    }
  }

  function useModelFromManager(model: ModelEntry) {
    setSelectedWorkflowId("");
    setTask(model.tasks.includes(task) ? task : model.tasks[0]);
    setSelectedModelId(model.id);
    setModelManagerOpen(false);
  }

  function clearModelFilters() {
    setModelFilter("");
    setModelStatusFilter("all");
    setModelTaskFilter("all");
    setModelBackendFilter("all");
  }

  function setRenderOption(option: ModelOptionDefinition, value: RenderOptionValue) {
    setRenderOptions((existing) => ({
      ...existing,
      [option.id]: coerceRenderOptionValue(option, value),
    }));
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
        <div className="brand-lockup">
          <img className="brand-logo" src={themeMode === "dark" ? logoRowWhite : logoRow} alt="" aria-hidden="true" />
          <h1 className="sr-only">Track Extract</h1>
        </div>
        <div className="topbar-actions">
          <button
            className="theme-toggle"
            type="button"
            onClick={() => setThemeMode((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={`Switch to ${themeMode === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${themeMode === "dark" ? "light" : "dark"} mode`}
          >
            {themeMode === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
            <span>{themeMode === "dark" ? "Light" : "Dark"}</span>
          </button>
          <div className="status-strip" aria-live="polite">
            <span className={`status-dot ${error ? "is-error" : runningJob ? "is-running" : ""}`} />
            <span>{error ?? status}</span>
          </div>
        </div>
      </header>

      <section className="workspace">
        <div className="scroll-shell rail-shell">
          <aside className="rail" ref={leftRailRef}>
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
                <div className="project-block">
                  <div className="project-summary">
                    <strong>{project.name}</strong>
                    <span>
                      {project.originalFiles.length} source file{project.originalFiles.length === 1 ? "" : "s"} ·{" "}
                      {project.stems.length} stem{project.stems.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="workspace-cleanup" aria-label="Workspace cleanup">
                    <button
                      className="danger-action"
                      type="button"
                      onClick={clearSourceAudio}
                      disabled={isBusy || project.originalFiles.length === 0 || Boolean(runningJob)}
                    >
                      <Trash2 aria-hidden />
                      Clear source
                    </button>
                  </div>
                </div>
              ) : (
                <p className="empty-copy">Start with a full mix or batch of tracks.</p>
              )}
            </section>

            <section className="panel workflow-panel">
              <div className="panel-heading">
                <SlidersHorizontal aria-hidden />
                <h2>Workflow</h2>
              </div>
              <div className="workflow-list" role="radiogroup" aria-label="Workflow">
                {workflows.map((workflow) => (
                  <button
                    className={selectedWorkflowId === workflow.id ? "workflow-option is-selected" : "workflow-option"}
                    key={workflow.id}
                    type="button"
                    onClick={() => setSelectedWorkflowId(workflow.id)}
                  >
                    <span>{workflow.displayName}</span>
                    <small>
                      {workflow.kind} · {workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"}
                    </small>
                  </button>
                ))}
              </div>
              <button className="secondary-action compact-action" type="button" onClick={refreshWorkflows}>
                <RefreshCw aria-hidden />
                Refresh workflows
              </button>

              {project && project.originalFiles.length > 1 ? (
                <label className="field-label">
                  Source
                  <select value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.currentTarget.value)}>
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
          <ColumnScrollbar metrics={leftRailScrollbar} targetRef={leftRailRef} />
        </div>

        <div className="scroll-shell main-shell">
          <section className="main-column" ref={mainColumnRef}>
            {selectedSource ? (
              <section className="panel source-panel">
                <SourcePreview source={selectedSource} mediaUrl={sourceMediaUrls[selectedSource.id]} />
              </section>
            ) : null}

            <section className="panel run-panel">
              <div>
                <div className="panel-heading">
                  <ListMusic aria-hidden />
                  <h2>Run</h2>
                </div>
                <p className="panel-copy">
                  {selectedWorkflow
                    ? `${selectedWorkflow.displayName}: ${selectedWorkflow.description}`
                    : "Ad hoc model setup. Save it as a named workflow when it feels right."}
                </p>
                <p className="panel-copy">
                  {selectedWorkflow && selectedWorkflow.steps.length > 1
                    ? `${selectedWorkflow.steps.length}-step workflow · ${
                        workflowIssues.length === 0
                          ? "all models ready"
                          : `${workflowIssues.length} step${workflowIssues.length === 1 ? "" : "s"} need setup`
                      }`
                    : selectedModel
                      ? `Model: ${selectedModel.displayName}`
                      : "No model selected"}
                </p>
              </div>
              <div className="run-actions">
                <button
                  className="primary-action"
                  type="button"
                  onClick={runSeparation}
                  disabled={!project || !selectedSource || !workflowCanRun || isBusy || Boolean(runningJob)}
                >
                  {runningJob ? <Pause aria-hidden /> : <Play aria-hidden />}
                  Run workflow
                </button>
              </div>
            </section>

            <section className="panel options-panel">
              <div className="panel-heading">
                <SlidersHorizontal aria-hidden />
                <h2>Render Options</h2>
              </div>
              {selectedModelOptions.length === 0 ? (
                <div className="empty-state compact">
                  <span>Default render settings</span>
                </div>
              ) : (
                <div className="option-grid">
                  {selectedModelOptions.map((option) => (
                    <label className="option-field" key={option.id} title={option.description}>
                      <span>{option.displayName}</span>
                      <RenderOptionControl
                        option={option}
                        value={renderOptions[option.id] ?? option.defaultValue}
                        onChange={(value) => setRenderOption(option, value)}
                      />
                    </label>
                  ))}
                </div>
              )}
              <div className="custom-workflow-row">
                <input
                  aria-label="Custom workflow name"
                  onChange={(event) => setCustomWorkflowName(event.currentTarget.value)}
                  placeholder="Name this workflow"
                  type="text"
                  value={customWorkflowName}
                />
                <button className="secondary-action inline-action" type="button" onClick={saveCurrentWorkflow}>
                  <Save aria-hidden />
                  Save workflow
                </button>
              </div>
            </section>

            <section className="panel queue-panel">
              <div className="panel-heading with-action">
                <span>
                  <ListMusic aria-hidden />
                  <h2>Job Queue</h2>
                </span>
                <div className="queue-heading-actions">
                  <button
                    className="secondary-action inline-action"
                    type="button"
                    onClick={cancelRunningJob}
                    disabled={!runningJob}
                  >
                    <Square aria-hidden />
                    Cancel
                  </button>
                  <button
                    className="secondary-action inline-action"
                    type="button"
                    onClick={clearJobHistory}
                    disabled={jobs.length === 0 || Boolean(runningJob) || isBusy}
                  >
                    <Trash2 aria-hidden />
                    Clear jobs
                  </button>
                </div>
              </div>
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
              <div className="panel-heading with-action">
                <span>
                  <Music2 aria-hidden />
                  <h2>Stem Preview</h2>
                </span>
                <button
                  className="icon-button"
                  type="button"
                  onClick={clearGeneratedStems}
                  disabled={!project || project.stems.length === 0 || isBusy || Boolean(runningJob)}
                  aria-label="Clear generated stems"
                  title="Clear generated stems"
                >
                  <Trash2 aria-hidden />
                </button>
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
                      mediaUrl={mediaUrls[stem.id]}
                      onSelect={() => toggleStemSelection(stem.id)}
                      onUpdate={(patch) => setStemPreview(stem.id, patch)}
                    />
                  ))}
                </div>
              )}
            </section>
          </section>
          <ColumnScrollbar metrics={mainColumnScrollbar} targetRef={mainColumnRef} />
        </div>

        <div className="scroll-shell rail-shell model-shell">
          <aside className="rail model-rail" ref={rightRailRef}>
            <section className="panel model-summary-panel">
              <div className="panel-heading">
                <Database aria-hidden />
                <h2>Model Setup</h2>
              </div>

              <div className="model-summary-strip" aria-label="Model registry summary">
                <span>{modelCounts.total} total</span>
                <span>{modelCounts.runnable} runnable</span>
                <span>{modelCounts.installable} installable</span>
                <span>{modelCounts.missing} catalog</span>
              </div>

              <div className="selected-model-card">
                <span className="summary-label">Selected model</span>
                {selectedModel ? (
                  <>
                    <strong>{selectedModel.displayName}</strong>
                    <small>
                      {selectedModel.backend} · {selectedModel.quality} · {formatTask(task)}
                    </small>
                    <ModelStatusPill model={selectedModel} progress={modelInstallProgress[selectedModel.id]} />
                  </>
                ) : (
                  <strong>No model selected</strong>
                )}
              </div>

              <div className="workflow-step-list compact-step-list">
                {(
                  selectedWorkflow?.steps ?? [
                    {
                      id: "ad_hoc",
                      displayName: "Ad hoc step",
                      task,
                      modelId: selectedModelId,
                      options: renderOptions,
                    },
                  ]
                ).map((step, index) => {
                  const stepModel = models.find((model) => model.id === step.modelId);
                  return (
                    <article className="workflow-step-row compact-step-row" key={step.id}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{step.displayName}</strong>
                        <small>{stepModel?.displayName ?? step.modelId}</small>
                        {stepModel ? (
                          <small>{modelStatusText(stepModel, modelInstallProgress[stepModel.id])}</small>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>

              {selectedWorkflow && workflowIssues.length > 0 ? (
                <div className="workflow-readiness">
                  <AlertTriangle aria-hidden />
                  <div>
                    <strong>
                      {workflowIssues.length} step{workflowIssues.length === 1 ? "" : "s"} need setup
                    </strong>
                    <small>{workflowStepIssueText(workflowIssues[0])}</small>
                  </div>
                </div>
              ) : null}

              {selectedWorkflow && workflowInstallTargets.length > 0 ? (
                <button
                  className="secondary-action"
                  type="button"
                  onClick={installSelectedWorkflowModels}
                  disabled={isBusy || workflowInstallBusy}
                >
                  <Download aria-hidden />
                  Install workflow models
                </button>
              ) : null}

              <button className="secondary-action" type="button" onClick={() => setModelManagerOpen(true)}>
                <Database aria-hidden />
                Manage models
              </button>
            </section>

            <section className="panel export-panel">
              <div className="panel-heading">
                <Download aria-hidden />
                <h2>Export</h2>
              </div>
              <label className="field-label export-format-field">
                Format
                <select
                  value={exportFormat}
                  onChange={(event) => setExportFormat(event.currentTarget.value as ExportFormat)}
                >
                  {EXPORT_FORMATS.map((format) => (
                    <option key={format.value} value={format.value}>
                      {format.label} · {format.description}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary-action"
                type="button"
                onClick={exportSelectedStems}
                disabled={!project || project.stems.length === 0}
              >
                <Download aria-hidden />
                Export selected
              </button>
              <p className="export-count">
                {selectedStemIds.length || 0} of {project?.stems.length ?? 0} stems selected
              </p>
            </section>

            <div className="panel-scroll-shell details-shell">
              <section className="panel details-panel" ref={detailsPanelRef}>
                <div className="panel-heading">
                  <FolderOpen aria-hidden />
                  <h2>Project</h2>
                </div>
                <dl>
                  <div>
                    <dt>Name</dt>
                    <dd>{project?.name ?? "No project"}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{selectedSource?.originalName ?? "None"}</dd>
                  </div>
                  <div>
                    <dt>Audio</dt>
                    <dd>{selectedSource ? formatAudioSummary(selectedSource) : "Waiting for import"}</dd>
                  </div>
                  <div>
                    <dt>Stems</dt>
                    <dd>{project?.stems.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Latest job</dt>
                    <dd>{latestJob ? latestJob.state : "None"}</dd>
                  </div>
                  <div>
                    <dt>Folder</dt>
                    <dd>{project?.rootPath ?? boot?.projectRoot ?? "Loading"}</dd>
                  </div>
                  <div>
                    <dt>Registry</dt>
                    <dd>{boot?.modelRegistryPath ?? "Loading"}</dd>
                  </div>
                </dl>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={revealCurrentProject}
                  disabled={!project && !boot?.projectRoot}
                >
                  <FolderOpen aria-hidden />
                  Open project folder
                </button>
                {logEntries.length > 0 ? (
                  <ul className="log-list">
                    {logEntries.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
              <ColumnScrollbar metrics={detailsPanelScrollbar} targetRef={detailsPanelRef} />
            </div>
          </aside>
          <ColumnScrollbar metrics={rightRailScrollbar} targetRef={rightRailRef} />
        </div>
      </section>
      {modelManagerOpen ? (
        <ModelManager
          backendFilter={modelBackendFilter}
          counts={modelCounts}
          filter={modelFilter}
          installProgress={modelInstallProgress}
          models={filteredModels}
          onClose={() => setModelManagerOpen(false)}
          onBackendFilterChange={setModelBackendFilter}
          onClearFilters={clearModelFilters}
          onFilterChange={setModelFilter}
          onInstall={installModel}
          onOpenSource={openModelSource}
          onRefresh={refreshModels}
          onSyncCatalog={syncAudioSeparatorCatalog}
          onStatusFilterChange={setModelStatusFilter}
          onTaskFilterChange={setModelTaskFilter}
          onUse={useModelFromManager}
          selectedModelId={selectedModelId}
          statusFilter={modelStatusFilter}
          taskFilter={modelTaskFilter}
        />
      ) : null}
    </main>
  );
}

function ModelManager({
  backendFilter,
  counts,
  filter,
  installProgress,
  models,
  onClose,
  onBackendFilterChange,
  onClearFilters,
  onFilterChange,
  onInstall,
  onOpenSource,
  onRefresh,
  onSyncCatalog,
  onStatusFilterChange,
  onTaskFilterChange,
  onUse,
  selectedModelId,
  statusFilter,
  taskFilter,
}: {
  backendFilter: ModelBackendFilter;
  counts: {
    total: number;
    runnable: number;
    installable: number;
    pending: number;
    missing: number;
  };
  filter: string;
  installProgress: Record<string, ModelDownloadProgress>;
  models: ModelEntry[];
  onClose: () => void;
  onBackendFilterChange: (value: ModelBackendFilter) => void;
  onClearFilters: () => void;
  onFilterChange: (value: string) => void;
  onInstall: (model: ModelEntry) => void;
  onOpenSource: (model: ModelEntry) => void;
  onRefresh: () => void;
  onSyncCatalog: () => void;
  onStatusFilterChange: (value: ModelStatusFilter) => void;
  onTaskFilterChange: (value: ModelTaskFilter) => void;
  onUse: (model: ModelEntry) => void;
  selectedModelId: string;
  statusFilter: ModelStatusFilter;
  taskFilter: ModelTaskFilter;
}) {
  const filtersActive =
    Boolean(filter.trim()) || statusFilter !== "all" || taskFilter !== "all" || backendFilter !== "all";

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label="Model Library" aria-modal="true" className="model-manager model-library" role="dialog">
        <div className="modal-heading library-heading">
          <span>
            <Database aria-hidden />
            <span>
              <h2>Model Library</h2>
              <small>
                {models.length} of {counts.total} models visible
              </small>
            </span>
          </span>
          <button className="icon-button" type="button" onClick={onClose} title="Close model library">
            <X aria-hidden />
          </button>
        </div>

        <div className="model-library-stats" aria-label="Model library summary">
          <span>
            <strong>{counts.total}</strong>Total
          </span>
          <span>
            <strong>{counts.runnable}</strong>Runnable
          </span>
          <span>
            <strong>{counts.installable}</strong>Installable
          </span>
          <span>
            <strong>{counts.pending}</strong>Needs definition
          </span>
          <span>
            <strong>{counts.missing}</strong>Catalog only
          </span>
        </div>

        <div className="model-manager-toolbar">
          <input
            aria-label="Filter models"
            onChange={(event) => onFilterChange(event.currentTarget.value)}
            placeholder="Search name, task, backend, version"
            type="search"
            value={filter}
          />
          <select
            aria-label="Status filter"
            value={statusFilter}
            onChange={(event) => onStatusFilterChange(event.currentTarget.value as ModelStatusFilter)}
          >
            {MODEL_STATUS_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Task filter"
            value={taskFilter}
            onChange={(event) => onTaskFilterChange(event.currentTarget.value as ModelTaskFilter)}
          >
            <option value="all">All tasks</option>
            {TASKS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Backend filter"
            value={backendFilter}
            onChange={(event) => onBackendFilterChange(event.currentTarget.value as ModelBackendFilter)}
          >
            {MODEL_BACKEND_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <button className="secondary-action inline-action" type="button" onClick={onRefresh}>
            <RefreshCw aria-hidden />
            Refresh
          </button>
          <button className="secondary-action inline-action" type="button" onClick={onSyncCatalog}>
            <Database aria-hidden />
            Sync audio-separator
          </button>
          {filtersActive ? (
            <button className="secondary-action inline-action" type="button" onClick={onClearFilters}>
              Clear
            </button>
          ) : null}
        </div>

        <div className="model-library-header" aria-hidden="true">
          <span>Model</span>
          <span>Tasks</span>
          <span>Backend</span>
          <span>Status</span>
          <span>Actions</span>
        </div>

        <div className="manager-model-list model-library-list">
          {models.length === 0 ? (
            <div className="empty-state">
              <Database aria-hidden />
              <span>No models match the current filters.</span>
            </div>
          ) : (
            models.map((model) => (
              <article
                className={
                  selectedModelId === model.id
                    ? "manager-model-row library-model-row is-selected"
                    : "manager-model-row library-model-row"
                }
                key={model.id}
              >
                <div className="library-model-title">
                  <strong>{model.displayName}</strong>
                  <small>{model.id}</small>
                  <small>{model.version}</small>
                </div>
                <div className="library-task-list">
                  {model.tasks.map((task) => (
                    <span key={task}>{formatTask(task)}</span>
                  ))}
                </div>
                <div className="library-model-meta">
                  <strong>{model.backend}</strong>
                  <small>
                    {model.quality} · {formatSampleRate(model.sampleRate)}
                  </small>
                  <small>
                    {model.downloadSizeMb ? `${model.downloadSizeMb} MB` : (model.license ?? "No packaged file")}
                  </small>
                </div>
                <div className="library-model-status">
                  <ModelStatusPill model={model} progress={installProgress[model.id]} />
                </div>
                <div className="manager-model-actions library-model-actions">
                  <button className="secondary-action inline-action" type="button" onClick={() => onUse(model)}>
                    <SlidersHorizontal aria-hidden />
                    Use
                  </button>
                  {isInstallableModel(model) ? (
                    <button
                      className="secondary-action inline-action"
                      type="button"
                      onClick={() => onInstall(model)}
                      disabled={Boolean(installProgress[model.id])}
                    >
                      <Download aria-hidden />
                      {installProgress[model.id]
                        ? `${Math.round(installProgress[model.id].progress * 100)}%`
                        : "Install"}
                    </button>
                  ) : null}
                  {model.sourceUrl || model.downloadUrl ? (
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => onOpenSource(model)}
                      title="Open model source"
                    >
                      <ExternalLink aria-hidden />
                    </button>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function RenderOptionControl({
  option,
  value,
  onChange,
}: {
  option: ModelOptionDefinition;
  value: RenderOptionValue;
  onChange: (value: RenderOptionValue) => void;
}) {
  if (option.type === "select") {
    return (
      <select value={String(value)} onChange={(event) => onChange(event.currentTarget.value)}>
        {(option.choices ?? []).map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }

  if (option.type === "boolean") {
    return (
      <input checked={Boolean(value)} onChange={(event) => onChange(event.currentTarget.checked)} type="checkbox" />
    );
  }

  return (
    <input
      max={option.max}
      min={option.min}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      step={option.step ?? (option.type === "integer" ? 1 : 0.01)}
      type="number"
      value={Number(value)}
    />
  );
}

const emptyScrollMetrics: ScrollMetrics = { progress: 0, thumbRatio: 0, visible: false };

function useScrollMetrics(targetRef: { current: HTMLElement | null }) {
  const [metrics, setMetrics] = useState<ScrollMetrics>(emptyScrollMetrics);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) {
      setMetrics(emptyScrollMetrics);
      return;
    }

    let animationFrame = 0;

    const update = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const { clientHeight, scrollHeight, scrollTop } = target;
        const visible = scrollHeight > clientHeight + 2;
        if (!visible) {
          setMetrics((current) => (current.visible ? emptyScrollMetrics : current));
          return;
        }

        const maxScroll = Math.max(1, scrollHeight - clientHeight);
        const progress = clamp(scrollTop / maxScroll, 0, 1);
        const thumbRatio = clamp(clientHeight / scrollHeight, 0, 1);
        setMetrics((current) =>
          current.visible === visible && current.progress === progress && current.thumbRatio === thumbRatio
            ? current
            : { progress, thumbRatio, visible },
        );
      });
    };

    update();
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resizeObserver?.observe(target);

    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    mutationObserver?.observe(target, { childList: true, subtree: true });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [targetRef]);

  return metrics;
}

function ColumnScrollbar({
  metrics,
  targetRef,
}: {
  metrics: ScrollMetrics;
  targetRef: { current: HTMLElement | null };
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragOffsetRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [trackHeight, setTrackHeight] = useState(0);
  const thumbHeight = metrics.visible ? Math.max(44, Math.round(metrics.thumbRatio * trackHeight)) : 0;
  const thumbTop = metrics.visible ? Math.round(metrics.progress * Math.max(0, trackHeight - thumbHeight)) : 0;

  useEffect(() => {
    const track = trackRef.current;
    if (!track) {
      setTrackHeight(0);
      return;
    }

    const update = () => setTrackHeight(track.getBoundingClientRect().height);
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  function scrollToClientY(clientY: number, offset: number) {
    const target = targetRef.current;
    const track = trackRef.current;
    if (!target || !track || !metrics.visible) {
      return;
    }

    const trackRect = track.getBoundingClientRect();
    const maxTop = Math.max(1, trackRect.height - thumbHeight);
    const top = clamp(clientY - trackRect.top - offset, 0, maxTop);
    target.scrollTop = (top / maxTop) * Math.max(0, target.scrollHeight - target.clientHeight);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!metrics.visible) {
      return;
    }

    const targetElement = event.target as HTMLElement;
    const thumb = targetElement.closest(".column-scrollbar-thumb");
    const thumbRect = thumb?.getBoundingClientRect();
    dragOffsetRef.current = thumbRect ? event.clientY - thumbRect.top : thumbHeight / 2;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    setDragging(true);
    scrollToClientY(event.clientY, dragOffsetRef.current);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragging) {
      event.preventDefault();
      scrollToClientY(event.clientY, dragOffsetRef.current);
    }
  }

  function stopDragging(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }

  return (
    <div
      aria-hidden
      className={`column-scrollbar ${metrics.visible ? "is-visible" : ""} ${dragging ? "is-dragging" : ""}`}
      onPointerCancel={stopDragging}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      ref={trackRef}
      style={
        {
          "--scrollbar-height": `${thumbHeight}px`,
          "--scrollbar-top": `${thumbTop}px`,
        } as React.CSSProperties
      }
    >
      <span className="column-scrollbar-thumb" />
    </div>
  );
}

const waveformCache = new Map<string, WaveformData>();

function AudioWaveform({
  mediaUrl,
  label,
  durationSeconds,
  audioRef,
  onSeek,
}: {
  mediaUrl?: string;
  label: string;
  durationSeconds?: number | null;
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  onSeek?: (ratio: number, fallbackDuration: number) => Promise<void> | void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [waveformState, setWaveformState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!mediaUrl) {
      setWaveform(null);
      setWaveformState("idle");
      return () => {
        cancelled = true;
      };
    }

    const cached = waveformCache.get(mediaUrl);
    if (cached) {
      setWaveform(cached);
      setWaveformState("ready");
      return () => {
        cancelled = true;
      };
    }

    setWaveform(null);
    setWaveformState("loading");

    loadWaveformData(mediaUrl)
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        waveformCache.set(mediaUrl, loaded);
        setWaveform(loaded);
        setWaveformState("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setWaveform(null);
          setWaveformState("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mediaUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const draw = () => {
      drawWaveformCanvas(canvas, waveform?.peaks ?? null, waveformState, playbackProgress);
    };

    draw();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [playbackProgress, waveform, waveformState]);

  useEffect(() => {
    const audio = audioRef?.current;
    if (!audio) {
      setPlaybackProgress(0);
      setIsPlaying(false);
      return;
    }

    const updateProgress = () => {
      const duration = audio.duration || durationSeconds || waveform?.durationSeconds || 0;
      setPlaybackProgress(duration > 0 ? clamp(audio.currentTime / duration, 0, 1) : 0);
    };
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);
      setPlaybackProgress(1);
    };

    updateProgress();
    audio.addEventListener("loadedmetadata", updateProgress);
    audio.addEventListener("durationchange", updateProgress);
    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("seeking", updateProgress);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("loadedmetadata", updateProgress);
      audio.removeEventListener("durationchange", updateProgress);
      audio.removeEventListener("timeupdate", updateProgress);
      audio.removeEventListener("seeking", updateProgress);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [audioRef, durationSeconds, mediaUrl, waveform?.durationSeconds]);

  function handleWaveformClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (!mediaUrl || !onSeek) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
    const duration = durationSeconds || waveform?.durationSeconds || 0;
    setPlaybackProgress(ratio);

    Promise.resolve(onSeek(ratio, duration)).catch(() => {
      setWaveformState((current) => (current === "idle" ? "error" : current));
    });
  }

  const displayedDuration = durationSeconds ?? waveform?.durationSeconds;
  const detail =
    isPlaying && typeof displayedDuration === "number"
      ? `${formatDuration(playbackProgress * displayedDuration)} / ${formatDuration(displayedDuration)}`
      : waveformState === "loading"
        ? "Reading waveform"
        : waveformState === "error"
          ? "Waveform unavailable"
          : typeof displayedDuration === "number"
            ? formatDuration(displayedDuration)
            : "Waiting for audio";

  return (
    <button
      aria-label={`Play ${label} from waveform`}
      className={`waveform-card waveform-${waveformState} ${isPlaying ? "is-playing" : ""}`}
      disabled={!mediaUrl || !onSeek}
      onClick={handleWaveformClick}
      type="button"
    >
      <canvas ref={canvasRef} className="waveform-canvas" />
      <div className="waveform-meta">
        <span>{detail}</span>
      </div>
    </button>
  );
}

function SourcePreview({ source, mediaUrl }: { source: AudioSource; mediaUrl?: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  useEffect(() => {
    setMediaError(null);
    audioRef.current?.load();
  }, [mediaUrl]);

  async function seekAndPlay(ratio: number, fallbackDuration: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const duration = audio.duration || fallbackDuration || source.durationSeconds || 0;
    if (duration > 0) {
      audio.currentTime = ratio * duration;
    }
    await audio.play();
  }

  return (
    <>
      <div className="panel-heading">
        <Music2 aria-hidden />
        <h2>Source Waveform</h2>
      </div>
      <div className="source-waveform-header">
        <strong>{source.originalName}</strong>
        <span>{formatAudioSummary(source)}</span>
      </div>
      <div className="source-audio">
        <AudioWaveform
          audioRef={audioRef}
          durationSeconds={source.durationSeconds}
          label={source.originalName}
          mediaUrl={mediaUrl}
          onSeek={seekAndPlay}
        />
        <audio
          ref={audioRef}
          controls
          onCanPlay={() => setMediaError(null)}
          onError={() => setMediaError(describeMediaError(audioRef.current?.error))}
          preload="metadata"
        >
          {mediaUrl ? <source src={mediaUrl} type={audioMimeType(source.projectPath || source.sourcePath)} /> : null}
        </audio>
        {mediaError ? <span className="media-error">{mediaError}</span> : null}
      </div>
    </>
  );
}

function audioMimeType(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "wav":
      return "audio/wav";
    case "aif":
    case "aiff":
      return "audio/aiff";
    case "flac":
      return "audio/flac";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    default:
      return "audio/*";
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function loadWaveformData(mediaUrl: string): Promise<WaveformData> {
  if (typeof window === "undefined" || typeof fetch === "undefined") {
    throw new Error("Waveform decoding is not available.");
  }

  const AudioContextConstructor =
    window.AudioContext ??
    (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("This browser cannot decode waveform previews.");
  }

  const response = await fetch(mediaUrl);
  if (!response.ok) {
    throw new Error("Could not load audio for waveform preview.");
  }

  const bytes = await response.arrayBuffer();
  const context = new AudioContextConstructor();
  try {
    const audioBuffer = await context.decodeAudioData(bytes.slice(0));
    return {
      durationSeconds: audioBuffer.duration,
      peaks: buildWaveformPeaks(audioBuffer, WAVEFORM_PEAK_COUNT),
    };
  } finally {
    void context.close();
  }
}

function buildWaveformPeaks(audioBuffer: AudioBuffer, peakCount: number) {
  const channels = Array.from({ length: Math.min(audioBuffer.numberOfChannels, 2) }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  if (channels.length === 0 || audioBuffer.length === 0) {
    return new Array(peakCount).fill(0.03);
  }

  const blockSize = Math.max(1, Math.floor(audioBuffer.length / peakCount));
  const peaks = new Array(peakCount).fill(0).map((_, blockIndex) => {
    const start = blockIndex * blockSize;
    const end = blockIndex === peakCount - 1 ? audioBuffer.length : Math.min(audioBuffer.length, start + blockSize);
    const stride = Math.max(1, Math.floor((end - start) / 420));
    let peak = 0;

    for (const channel of channels) {
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
        peak = Math.max(peak, Math.abs(channel[sampleIndex] ?? 0));
      }
    }

    return peak;
  });

  const maxPeak = Math.max(...peaks);
  if (maxPeak <= 0) {
    return peaks.map(() => 0.03);
  }

  return peaks.map((peak) => Math.max(0.035, peak / maxPeak));
}

function drawWaveformCanvas(
  canvas: HTMLCanvasElement,
  peaks: number[] | null,
  state: "idle" | "loading" | "ready" | "error",
  playbackProgress = 0,
) {
  const width = Math.max(1, Math.floor(canvas.clientWidth || 480));
  const height = Math.max(1, Math.floor(canvas.clientHeight || 70));
  const pixelRatio = window.devicePixelRatio || 1;

  if (canvas.width !== Math.floor(width * pixelRatio) || canvas.height !== Math.floor(height * pixelRatio)) {
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const styles = getComputedStyle(document.documentElement);
  const activeColor = styles.getPropertyValue("--accent").trim() || "#2dd4bf";
  const mutedColor = styles.getPropertyValue("--border-soft").trim() || "#333d4d";
  const warningColor = styles.getPropertyValue("--warning-strong").trim() || "#d6a846";
  const progressTrack = styles.getPropertyValue("--progress-track").trim() || "#293241";
  const bars = fitPeaksToCanvas(peaks ?? placeholderWaveformPeaks(), width);
  const gap = width < 420 ? 1.5 : 2;
  const barWidth = Math.max(1.5, (width - gap * (bars.length - 1)) / bars.length);
  const center = height / 2;
  const verticalPadding = 9;
  const fill =
    state === "ready"
      ? progressTrack
      : state === "error"
        ? warningColor
        : state === "loading"
          ? mutedColor
          : mutedColor;

  drawWaveformBars(context, bars, barWidth, gap, center, height, verticalPadding, fill);
  if (state === "ready" && playbackProgress > 0) {
    context.save();
    context.beginPath();
    context.rect(0, 0, width * clamp(playbackProgress, 0, 1), height);
    context.clip();
    drawWaveformBars(context, bars, barWidth, gap, center, height, verticalPadding, activeColor);
    context.restore();
  }

  if (playbackProgress > 0 && state === "ready") {
    context.fillStyle = activeColor;
    context.fillRect(Math.max(0, width * playbackProgress - 1), 6, 2, height - 12);
  }
}

function drawWaveformBars(
  context: CanvasRenderingContext2D,
  bars: number[],
  barWidth: number,
  gap: number,
  center: number,
  height: number,
  verticalPadding: number,
  fill: string,
) {
  context.fillStyle = fill;
  for (const [index, peak] of bars.entries()) {
    const barHeight = Math.max(2, peak * (height - verticalPadding * 2));
    const x = index * (barWidth + gap);
    const y = center - barHeight / 2;
    drawRoundedBar(context, x, y, barWidth, barHeight, Math.min(3, barWidth / 2));
  }
}

function fitPeaksToCanvas(peaks: number[], width: number) {
  const targetCount = Math.min(peaks.length, Math.max(40, Math.floor(width / 4)));
  if (targetCount >= peaks.length) {
    return peaks;
  }

  const bucketSize = peaks.length / targetCount;
  return new Array(targetCount).fill(0).map((_, bucketIndex) => {
    const start = Math.floor(bucketIndex * bucketSize);
    const end = Math.max(start + 1, Math.floor((bucketIndex + 1) * bucketSize));
    return Math.max(...peaks.slice(start, end));
  });
}

function placeholderWaveformPeaks() {
  return new Array(WAVEFORM_PEAK_COUNT).fill(0).map((_, index) => 0.12 + Math.sin(index * 0.31) ** 2 * 0.34);
}

function drawRoundedBar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function StemPreview({
  stem,
  state,
  soloActive,
  selected,
  mediaUrl,
  onSelect,
  onUpdate,
}: {
  stem: StemFile;
  state: PreviewState;
  soloActive: boolean;
  selected: boolean;
  mediaUrl?: string;
  onSelect: () => void;
  onUpdate: (patch: Partial<PreviewState>) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const isAudible = !state.muted && (!soloActive || state.solo);
  const source = mediaUrl;

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = state.volume;
    }
  }, [state.volume]);

  useEffect(() => {
    setMediaError(null);
    audioRef.current?.load();
  }, [source]);

  async function seekAndPlay(ratio: number, fallbackDuration: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const duration = audio.duration || fallbackDuration || 0;
    if (duration > 0) {
      audio.currentTime = ratio * duration;
    }
    await audio.play();
  }

  return (
    <article className="stem-row">
      <label className="stem-select">
        <input type="checkbox" checked={selected} onChange={onSelect} />
        <span>{stem.label}</span>
      </label>
      <div className="stem-audio">
        <AudioWaveform audioRef={audioRef} label={`${stem.label} waveform`} mediaUrl={source} onSeek={seekAndPlay} />
        <audio
          ref={audioRef}
          controls
          muted={!isAudible}
          onCanPlay={() => setMediaError(null)}
          onError={() => setMediaError(describeMediaError(audioRef.current?.error))}
          preload="metadata"
        >
          {source ? <source src={source} type={audioMimeType(stem.path)} /> : null}
        </audio>
        {mediaError ? <span className="media-error">{mediaError}</span> : null}
      </div>
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

function describeMediaError(error: MediaError | null | undefined) {
  switch (error?.code) {
    case 1:
      return "Playback was aborted.";
    case 2:
      return "Could not load the full stem file.";
    case 3:
      return "The audio decoder could not read this stem.";
    case 4:
      return "This stem source is not supported by the preview player.";
    default:
      return "The preview player could not load this stem.";
  }
}

function StateBadge({ state }: { state: JobState }) {
  return <span className={`state-badge state-${state}`}>{state.replace("_", " ")}</span>;
}

function ModelStatusIcon({ model }: { model: ModelEntry }) {
  if (isRunnableModel(model)) {
    return <CheckCircle2 aria-label="Installed" />;
  }

  if (model.installed) {
    return <AlertTriangle aria-label="Needs model definition" />;
  }

  if (isInstallableModel(model)) {
    return <Download aria-label="Available to install" />;
  }

  if (model.sourceUrl || model.downloadUrl) {
    return <ExternalLink aria-label="Source reference" />;
  }

  return <X aria-label="Unavailable" />;
}

function ModelStatusPill({ model, progress }: { model: ModelEntry; progress?: ModelDownloadProgress }) {
  const status = modelStatusKey(model);

  return (
    <span className={`model-status-pill model-status-${status}`}>
      <ModelStatusIcon model={model} />
      {modelStatusText(model, progress)}
    </span>
  );
}

function formatTask(value: TaskType) {
  return TASKS.find((task) => task.value === value)?.label ?? value;
}

function formatSampleRate(sampleRate: number) {
  return `${(sampleRate / 1000).toFixed(1)} kHz`;
}

function defaultRenderOptions(model: ModelEntry) {
  return Object.fromEntries(
    (model.options ?? []).map((option) => [option.id, coerceRenderOptionValue(option, option.defaultValue)]),
  ) as Record<string, RenderOptionValue>;
}

function coerceRenderOptionValue(option: ModelOptionDefinition, value: RenderOptionValue) {
  if (option.type === "boolean") {
    return Boolean(value);
  }

  if (option.type === "integer") {
    return clampOptionNumber(option, Math.round(Number(value)));
  }

  if (option.type === "number") {
    return clampOptionNumber(option, Number(value));
  }

  const selected = String(value);
  const choices = option.choices ?? [];
  return choices.length > 0 && !choices.some((choice) => choice.value === selected)
    ? String(option.defaultValue)
    : selected;
}

function clampOptionNumber(option: ModelOptionDefinition, value: number) {
  const fallback = Number(option.defaultValue);
  let next = Number.isFinite(value) ? value : fallback;

  if (typeof option.min === "number") {
    next = Math.max(option.min, next);
  }

  if (typeof option.max === "number") {
    next = Math.min(option.max, next);
  }

  return next;
}

function formatAudioSummary(source: AudioSource) {
  const sampleRate = source.sampleRate ? `${(source.sampleRate / 1000).toFixed(1)} kHz` : "Unknown rate";
  const channels = source.channels ? `${source.channels} ch` : "Unknown channels";
  const duration =
    typeof source.durationSeconds === "number" ? formatDuration(source.durationSeconds) : "Unknown length";
  return `${sampleRate} · ${channels} · ${duration}`;
}

function findWorkflowInputStem(project: ProjectSession, label: string, previousJob: JobRecord | null) {
  const preferred = [...(previousJob?.stems ?? [])].reverse().find((stem) => stemLabelMatches(stem.label, label));
  if (preferred) {
    return preferred;
  }

  return [...project.stems].reverse().find((stem) => stemLabelMatches(stem.label, label)) ?? null;
}

function stemLabelMatches(candidate: string, expected: string) {
  return candidate.trim().toLowerCase() === expected.trim().toLowerCase();
}

function workflowStepReadinessIssues(workflow: WorkflowEntry, models: ModelEntry[]) {
  return workflow.steps.flatMap((step): WorkflowStepReadinessIssue[] => {
    const model = models.find((candidate) => candidate.id === step.modelId) ?? null;
    if (!model) {
      return [
        {
          step,
          model,
          message: `Workflow step "${step.displayName}" references missing model ${step.modelId}.`,
        },
      ];
    }

    if (!model.tasks.includes(step.task)) {
      return [
        {
          step,
          model,
          message: `Does not support ${formatTask(step.task)}.`,
        },
      ];
    }

    if (!model.installed) {
      return [
        {
          step,
          model,
          message: modelStatusText(model),
        },
      ];
    }

    if (!isRunnableModel(model)) {
      return [
        {
          step,
          model,
          message: "Installed but still needs a runnable model definition.",
        },
      ];
    }

    return [];
  });
}

function workflowInstallableModels(workflow: WorkflowEntry, models: ModelEntry[]) {
  const seen = new Set<string>();
  return workflowStepReadinessIssues(workflow, models)
    .map((issue) => issue.model)
    .filter((model): model is ModelEntry => model !== null)
    .filter(isInstallableModel)
    .filter((model) => {
      if (seen.has(model.id)) {
        return false;
      }
      seen.add(model.id);
      return true;
    });
}

function workflowStepIssueText(issue: WorkflowStepReadinessIssue) {
  return `Step "${issue.step.displayName}" needs ${issue.model?.displayName ?? issue.step.modelId}: ${issue.message}`;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "workflow"
  );
}

function isRunnableModel(model: ModelEntry) {
  const provider = model.runtime?.provider;
  return Boolean(
    model.installed &&
    ((model.backend === "python-engine" &&
      (provider === "demucs" || provider === "audio-separator" || provider === "stub")) ||
      model.backend === "pytorch-worker" ||
      model.backend === "stub"),
  );
}

function isInstallableModel(model: ModelEntry) {
  if (model.installed) {
    return false;
  }

  if (model.installMethod === "audio-separator") {
    return model.runtime?.provider === "audio-separator" && Boolean(model.runtime.modelFilename);
  }

  return model.installMethod === "direct-url" && Boolean(model.downloadUrl) && model.path.startsWith("models/");
}

function modelStatusKey(model: ModelEntry): ModelStatusKey {
  if (isRunnableModel(model)) {
    return "runnable";
  }

  if (model.installed) {
    return "pending";
  }

  if (isInstallableModel(model)) {
    return "installable";
  }

  return "missing";
}

function modelMatchesFilters(
  model: ModelEntry,
  query: string,
  statusFilter: ModelStatusFilter,
  taskFilter: ModelTaskFilter,
  backendFilter: ModelBackendFilter,
) {
  if (statusFilter !== "all" && modelStatusKey(model) !== statusFilter) {
    return false;
  }

  if (taskFilter !== "all" && !model.tasks.includes(taskFilter)) {
    return false;
  }

  if (backendFilter !== "all" && model.backend !== backendFilter) {
    return false;
  }

  if (!query) {
    return true;
  }

  return [
    model.id,
    model.displayName,
    model.backend,
    model.quality,
    model.version,
    model.notes,
    model.license,
    model.tasks.map(formatTask).join(" "),
    model.stems.join(" "),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function compareModelsForLibrary(left: ModelEntry, right: ModelEntry) {
  const rankDelta = modelLibraryRank(left) - modelLibraryRank(right);

  if (rankDelta !== 0) {
    return rankDelta;
  }

  return left.displayName.localeCompare(right.displayName);
}

function modelLibraryRank(model: ModelEntry) {
  if (isRunnableModel(model)) {
    return 0;
  }

  if (model.installed) {
    return 1;
  }

  if (isCuratedModel(model)) {
    return 2;
  }

  if (isInstallableModel(model)) {
    return 3;
  }

  if (model.id.startsWith("catalog_")) {
    return 4;
  }

  if (model.id.startsWith("mvsep_")) {
    return 5;
  }

  return 6;
}

function isCuratedModel(model: ModelEntry) {
  return (
    model.id.startsWith("onnx_") ||
    model.id === "uvr_mdx23c_instvoc_hq" ||
    model.id === "uvr_denoise" ||
    model.id === "catalog_roformer_vocals"
  );
}

function modelStatusText(model: ModelEntry, progress?: ModelDownloadProgress) {
  if (progress) {
    return progress.totalBytes ? `${progress.message} · ${Math.round(progress.progress * 100)}%` : progress.message;
  }

  if (isRunnableModel(model)) {
    return "Ready";
  }

  if (model.installed) {
    return "Installed · needs model definition";
  }

  if (isInstallableModel(model)) {
    return "Available to install";
  }

  if (model.sourceUrl || model.downloadUrl) {
    return "Source reference";
  }

  return model.backend === "python-engine" ? "Engine unavailable" : "Unavailable";
}

function cloneMockData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const mockModels: ModelEntry[] = cloneMockData(bundledModels as ModelEntry[]);
let mockWorkflows: WorkflowEntry[] = cloneMockData(bundledWorkflows as WorkflowEntry[]);

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
        workflowRegistryPath: "/mock/TrackExtract App Data/workflows.json",
        models: mockModels,
        workflows: mockWorkflows,
        currentProject: mockProject,
        jobs: mockJobs,
      } as T;

    case "list_models":
      return mockModels as T;

    case "sync_audio_separator_catalog": {
      const synced: ModelEntry = {
        id: "audio_separator_mock_roformer",
        displayName: "Mock audio-separator RoFormer",
        backend: "python-engine",
        tasks: ["vocals_instrumental"],
        stems: ["Vocals", "Instrumental"],
        sampleRate: 44100,
        quality: "best",
        version: "mock_roformer.ckpt",
        installed: false,
        path: "",
        downloadUrl: "",
        sourceUrl: "https://github.com/nomadkaraoke/python-audio-separator",
        license: "Model-specific",
        notes: "Mock synced model.",
        installMethod: "audio-separator",
        runtime: {
          provider: "audio-separator",
          modelFilename: "mock_roformer.ckpt",
        },
        options: [],
      };
      if (!mockModels.some((model) => model.id === synced.id)) {
        mockModels.push(synced);
      }
      return [...mockModels] as T;
    }

    case "list_workflows":
      return mockWorkflows as T;

    case "save_custom_workflow": {
      const workflow = args?.workflow as WorkflowEntry;
      const saved = { ...workflow, kind: "custom" as WorkflowKind };
      mockWorkflows = [...mockWorkflows.filter((candidate) => candidate.id !== saved.id), saved];
      return saved as T;
    }

    case "install_model": {
      const modelId = args?.modelId as string;
      const model = mockModels.find((candidate) => candidate.id === modelId);
      if (!model) {
        throw new Error("Mock model was not found.");
      }
      model.installed = true;
      return model as T;
    }

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

      const job = createMockJob(
        mockProject,
        task,
        model.id,
        (args?.options as Record<string, RenderOptionValue> | undefined) ?? {},
        (args?.sourceId as string | null | undefined) ?? null,
      );
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
        stems: [...mockProject.stems.filter((stem) => stem.sourceJobId !== job.id), ...stems],
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

    case "clear_jobs":
      if (mockJobs.some((job) => job.state === "preparing" || job.state === "running")) {
        throw new Error("Cancel the running job before clearing job history");
      }
      mockJobs = [];
      if (mockProject) {
        mockProject = {
          ...mockProject,
          jobs: [],
          updatedAt: new Date().toISOString(),
        };
      }
      return mockJobs as T;

    case "clear_project_stems":
      if (mockProject) {
        const clearedJobIds = new Set(mockProject.stems.map((stem) => stem.sourceJobId));
        mockProject = {
          ...mockProject,
          stems: [],
          updatedAt: new Date().toISOString(),
        };
        mockJobs = mockJobs.map((job) =>
          clearedJobIds.has(job.id) ? { ...job, stems: [], updatedAt: new Date().toISOString() } : job,
        );
      }
      return mockProject as T;

    case "clear_project_source":
      if (mockProject) {
        mockProject = {
          ...mockProject,
          originalFiles: [],
          jobs: [],
          stems: [],
          updatedAt: new Date().toISOString(),
        };
      }
      mockJobs = [];
      return mockProject as T;

    case "export_stems": {
      const destinationPath = (args?.destinationPath as string | undefined) ?? "/mock/export";
      const format = ((args?.format as string | undefined) ?? "wav").replace(/^aif$/, "aiff");
      const extension = format === "aiff" ? "aiff" : format;
      const exported = (mockProject?.stems ?? []).map(
        (stem) =>
          `${destinationPath}/${replaceExtension(lastPathPart(stem.path) ?? `${stem.label}.wav`, `.${extension}`)}`,
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

function createMockJob(
  project: ProjectSession,
  task: TaskType,
  modelId: string,
  options: Record<string, RenderOptionValue> = {},
  sourceId: string | null = null,
): JobRecord {
  const now = new Date().toISOString();
  const sources = [...project.originalFiles, ...project.stems];
  const requestedSource = sourceId ? sources.find((candidate) => candidate.id === sourceId) : null;
  if (sourceId && !requestedSource) {
    throw new Error("Selected source is no longer available in this project");
  }
  const source = requestedSource ?? project.originalFiles[0] ?? project.stems[0];

  return {
    id: mockId("job"),
    projectId: project.id,
    projectName: project.name,
    sourceId: source?.id ?? mockId("source"),
    sourcePath:
      ("projectPath" in (source ?? {})
        ? (source as AudioSource).projectPath
        : (source as StemFile | undefined)?.path) ?? `${project.rootPath}/original/mock.wav`,
    task,
    modelId,
    options,
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

function replaceExtension(fileName: string, extension: string) {
  return `${fileName.replace(/\.[^.]+$/, "")}${extension}`;
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
    const envelope = Math.sin((Math.PI * frame) / frames);
    const sample = Math.sin((2 * Math.PI * pitch * frame) / sampleRate) * envelope * 0.18;
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
