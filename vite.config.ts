/// <reference types="node" />
/// <reference types="vitest" />

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { isPathWithin, isTrustedDevRequest, parseByteRange } from "./scripts/dev-bridge-security";

const remoteHost = process.env.TAURI_DEV_HOST;
const devHost = remoteHost || "127.0.0.1";
const DEV_BRIDGE_PREFIX = "/__trackextract_dev";
const MAX_COMMAND_BODY_BYTES = 1024 * 1024;
const MAX_BROWSER_FILES = 16;
const MAX_BROWSER_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BROWSER_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const ENGINE_SYNC_COMMANDS = new Set([
  "bootstrap_app",
  "list_models",
  "list_workflows",
  "save_custom_workflow",
  "import_audio_files",
  "enqueue_separation",
  "cancel_job",
  "get_project",
  "get_jobs",
  "get_snapshot",
  "clear_jobs",
  "export_stems",
  "clear_project_stems",
  "delete_project_stem",
  "clear_project_source",
  "sync_audio_separator_catalog",
]);
const ENGINE_LONG_COMMANDS = new Set(["start_job", "install_model"]);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), trackExtractDevBridge()],
  test: {
    environment: "jsdom",
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**", "tests/demo-media/**", "tests/performance/**"],
    setupFiles: "./src/setupTests.ts",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: ".artifacts/coverage/frontend",
      thresholds: {
        branches: 60,
        functions: 60,
        lines: 65,
        statements: 65,
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: devHost,
    hmr: remoteHost
      ? {
          protocol: "ws",
          host: remoteHost,
          port: 1421,
        }
      : undefined,
    warmup: {
      clientFiles: ["./src/main.tsx", "./src/App.tsx", "./src/waveform.ts"],
    },
    watch: {
      // 3. tell Vite to ignore generated artifacts, native builds, and local worker environments
      ignored: [
        "**/.artifacts/**",
        "**/test-results/**",
        "**/src-tauri/**",
        "**/target/**",
        "**/.venv/**",
        "**/.venv-*/**",
        "**/__pycache__/**",
      ],
    },
  },
}));

function trackExtractDevBridge(): Plugin {
  const repoRoot = process.cwd();
  const context = {
    appDataDir: defaultAppDataDir(),
    projectRoot: defaultProjectRoot(),
    repoRoot,
    bundledModels: fs.readFileSync(path.join(repoRoot, "resources/models.json"), "utf8"),
    bundledWorkflows: fs.readFileSync(path.join(repoRoot, "resources/workflows.json"), "utf8"),
  };
  const runningChildren = new Map<string, ChildProcessWithoutNullStreams>();

  return {
    name: "trackextract-dev-bridge",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        if (!requestUrl.pathname.startsWith(DEV_BRIDGE_PREFIX)) {
          next();
          return;
        }

        if (!isTrustedDevRequest(request)) {
          sendJson(response, 403, { ok: false, message: "Cross-origin dev bridge request denied." });
          return;
        }

        if (request.method === "OPTIONS") {
          sendJson(response, 204, null);
          return;
        }

        try {
          const route = requestUrl.pathname.slice(DEV_BRIDGE_PREFIX.length) || "/";
          if (route === "/command" && request.method === "POST") {
            const { command, args = {} } = (await readJson(request)) as {
              command?: string;
              args?: Record<string, unknown>;
            };
            if (!command) {
              throw new Error("Missing Track Extract command.");
            }
            const payload = await handleDevCommand(command, args, context, runningChildren);
            sendJson(response, 200, { ok: true, payload });
            return;
          }

          if (route === "/import-files" && request.method === "POST") {
            const payload = await importBrowserFiles(request, context);
            sendJson(response, 200, { ok: true, payload });
            return;
          }

          if (route === "/stem" && (request.method === "GET" || request.method === "HEAD")) {
            await serveStemFile(request, response, requestUrl, request.method === "HEAD", context.projectRoot);
            return;
          }

          sendJson(response, 404, { ok: false, message: "Track Extract dev bridge route not found." });
        } catch (error) {
          sendJson(response, error instanceof HttpError ? error.status : 500, {
            ok: false,
            message: errorMessage(error),
          });
        }
      });
    },
  };
}

async function handleDevCommand(
  command: string,
  args: Record<string, unknown>,
  context: EngineContext,
  runningChildren: Map<string, ChildProcessWithoutNullStreams>,
) {
  if (command === "stem_media_url") {
    const mediaPath = path.resolve(String(args.path ?? ""));
    if (!isTrackExtractMediaPath(mediaPath, context.projectRoot)) {
      throw new HttpError(400, "Requested media path is outside Track Extract project media.");
    }
    return `${DEV_BRIDGE_PREFIX}/stem?path=${encodeURIComponent(mediaPath)}`;
  }

  if (command === "reveal_path") {
    const revealPath = path.resolve(String(args.path ?? ""));
    if (!isPathWithin(revealPath, context.projectRoot) && !isPathWithin(revealPath, context.appDataDir)) {
      throw new HttpError(400, "Track Extract can only reveal project and application data paths.");
    }
    openLocalPath(revealPath);
    return null;
  }

  if (command === "cancel_job") {
    const jobId = String(args.jobId ?? "");
    terminateTrackedChild(runningChildren, jobId);
    return runEngineJson(command, args, context);
  }

  if (ENGINE_LONG_COMMANDS.has(command)) {
    return runEngineJsonl(command, args, context, runningChildren);
  }

  if (ENGINE_SYNC_COMMANDS.has(command)) {
    return runEngineJson(command, args, context);
  }

  throw new Error(`Unknown Track Extract dev bridge command: ${command}`);
}

async function importBrowserFiles(request: IncomingMessage, context: EngineContext) {
  const contentType = request.headers["content-type"];
  if (!contentType?.includes("multipart/form-data")) {
    throw new HttpError(415, "Browser import requires multipart form data.");
  }

  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BROWSER_UPLOAD_BYTES) {
    throw new HttpError(413, "Browser import is larger than the 4 GiB upload limit.");
  }

  const importDir = path.join(context.appDataDir, "browser-imports", `${Date.now().toString(36)}-${randomUUID()}`);
  await mkdir(importDir, { recursive: true });

  try {
    const paths = await streamBrowserFiles(request, importDir);
    return await runEngineJson("import_audio_files", { paths }, context);
  } catch (error) {
    await rm(importDir, { recursive: true, force: true });
    throw error;
  }
}

function streamBrowserFiles(request: IncomingMessage, importDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const parser = Busboy({
      headers: request.headers,
      limits: {
        files: MAX_BROWSER_FILES,
        fileSize: MAX_BROWSER_FILE_BYTES,
        fields: 4,
        parts: MAX_BROWSER_FILES + 4,
      },
    });
    const paths: string[] = [];
    const writes: Promise<void>[] = [];
    const usedNames = new Set<string>();
    let totalBytes = 0;
    let uploadError: Error | null = null;

    parser.on("file", (fieldName, file, info) => {
      if (fieldName !== "files") {
        file.resume();
        return;
      }

      const fileName = sanitizeFileName(info.filename || "audio.wav");
      if (!audioContentType(fileName)) {
        uploadError ??= new HttpError(415, `Unsupported audio file: ${fileName}`);
        file.resume();
        return;
      }

      const destination = path.join(importDir, uniqueBrowserFileName(fileName, usedNames));
      paths.push(destination);
      file.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BROWSER_UPLOAD_BYTES) {
          const error = new HttpError(413, "Browser import is larger than the 4 GiB upload limit.");
          uploadError ??= error;
          request.unpipe(parser);
          request.resume();
          parser.destroy(error);
        }
      });
      file.on("limit", () => {
        uploadError ??= new HttpError(413, `${fileName} is larger than the 2 GiB per-file limit.`);
      });
      writes.push(pipeline(file, fs.createWriteStream(destination, { flags: "wx" })));
    });
    parser.on("filesLimit", () => {
      uploadError ??= new HttpError(413, `Browser import accepts at most ${MAX_BROWSER_FILES} files.`);
    });
    parser.on("error", reject);
    parser.on("close", () => {
      void Promise.all(writes).then(() => {
        if (uploadError) {
          reject(uploadError);
        } else if (paths.length === 0) {
          reject(new HttpError(400, "Choose at least one audio file to import."));
        } else {
          resolve(paths);
        }
      }, reject);
    });
    request.pipe(parser);
  });
}

function runEngineJson(command: string, args: Record<string, unknown>, context: EngineContext): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawnEngine(command, false, context);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout).trim() || `Python engine exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "null"));
      } catch (error) {
        reject(new Error(`Python engine returned invalid JSON for ${command}: ${errorMessage(error)}`));
      }
    });

    child.stdin.end(JSON.stringify(enginePayload(context, args)));
  });
}

async function runEngineJsonl(
  command: string,
  args: Record<string, unknown>,
  context: EngineContext,
  runningChildren: Map<string, ChildProcessWithoutNullStreams>,
): Promise<unknown> {
  const child = spawnEngine(command, true, context);
  child.stdin.end(JSON.stringify(enginePayload(context, args)));
  const runningKey = runningChildKey(command, args);
  if (runningKey) {
    runningChildren.set(runningKey, child);
  }

  let result: unknown;
  let stderr = "";
  const stderrDone = new Promise<void>((resolve) => {
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stderr.on("end", resolve);
  });

  const lines = readline.createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const envelope = JSON.parse(line) as EngineEnvelope;
      if (envelope.type === "result") {
        result = envelope.payload ?? null;
      } else if (envelope.type === "error") {
        throw new Error(envelope.message || "Python engine command failed");
      }
    }

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    await stderrDone;

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Python engine exited with ${exitCode}`);
    }

    return result ?? null;
  } finally {
    if (runningKey) {
      runningChildren.delete(runningKey);
    }
  }
}

function spawnEngine(command: string, jsonl: boolean, context: EngineContext): ChildProcessWithoutNullStreams {
  const args = ["-m", "trackextract_engine", command];
  if (jsonl) {
    args.push("--jsonl");
  }

  return spawn(resolveEnginePython(context.repoRoot), args, {
    cwd: context.repoRoot,
    detached: jsonl && process.platform !== "win32",
    env: {
      ...process.env,
      PYTHONPATH: [path.join(context.repoRoot, "engine/src"), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
    stdio: "pipe",
  });
}

function enginePayload(context: EngineContext, args: Record<string, unknown>) {
  return {
    context,
    args,
  };
}

function runningChildKey(command: string, args: Record<string, unknown>) {
  if (command === "start_job" && args.jobId) {
    return String(args.jobId);
  }
  if (command === "install_model" && args.modelId) {
    return `install:${String(args.modelId)}`;
  }
  return null;
}

function terminateTrackedChild(runningChildren: Map<string, ChildProcessWithoutNullStreams>, key: string) {
  const child = runningChildren.get(key);
  if (!child) {
    return;
  }
  runningChildren.delete(key);

  try {
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => child.kill("SIGTERM"));
      return;
    }
    if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // The child may have already exited; the follow-up cancel command still fixes persisted state.
  }
  child.kill("SIGTERM");
}

function resolveEnginePython(repoRoot: string) {
  if (process.env.TRACKEXTRACT_ENGINE_PYTHON) {
    return process.env.TRACKEXTRACT_ENGINE_PYTHON;
  }

  for (const relative of [".venv-trackextract-engine/bin/python", ".venv-trackextract-engine/Scripts/python.exe"]) {
    const candidate = path.join(repoRoot, relative);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "python3";
}

async function serveStemFile(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  headOnly: boolean,
  projectRoot: string,
) {
  const stemPath = requestUrl.searchParams.get("path");
  if (!stemPath) {
    sendText(response, 400, "Media request is missing a stem path.");
    return;
  }

  const unresolved = path.resolve(stemPath);
  const resolved = await fs.promises.realpath(unresolved).catch(() => unresolved);
  const resolvedProjectRoot = await fs.promises.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const contentType = audioContentType(resolved);
  if (!isTrackExtractMediaPath(resolved, resolvedProjectRoot) || !contentType) {
    sendText(response, 400, "Requested media path is outside Track Extract project media.");
    return;
  }

  const stat = await fs.promises.stat(resolved);
  const range = request.headers.range;
  if (range) {
    const { start, end } = parseByteRange(range, stat.size);
    response.writeHead(206, {
      "Accept-Ranges": "bytes",
      "Content-Length": end + 1 - start,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Type": contentType,
    });
    if (!headOnly) {
      fs.createReadStream(resolved, { start, end }).pipe(response);
    } else {
      response.end();
    }
    return;
  }

  response.writeHead(200, {
    "Accept-Ranges": "bytes",
    "Content-Length": stat.size,
    "Content-Type": contentType,
  });
  if (!headOnly) {
    fs.createReadStream(resolved).pipe(response);
  } else {
    response.end();
  }
}

function isTrackExtractMediaPath(value: string, projectRoot: string) {
  return (
    Boolean(audioContentType(value)) &&
    isPathWithin(value, projectRoot) &&
    ["original", "stems"].includes(path.basename(path.dirname(value)))
  );
}

function audioContentType(value: string) {
  switch (path.extname(value).toLowerCase()) {
    case ".wav":
      return "audio/wav";
    case ".aif":
    case ".aiff":
      return "audio/aiff";
    case ".flac":
      return "audio/flac";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    default:
      return null;
  }
}

function openLocalPath(value: string) {
  if (!value) {
    return;
  }
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [value], { detached: true, stdio: "ignore" }).unref();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(request, MAX_COMMAND_BODY_BYTES);
  return body.length === 0 ? {} : JSON.parse(body.toString("utf8"));
}

async function readRequestBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, "Dev bridge command is larger than the 1 MiB request limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(payload === null ? "" : JSON.stringify(payload));
}

function sendText(response: ServerResponse, status: number, message: string) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain");
  response.end(message);
}

function defaultAppDataDir() {
  if (process.env.TRACKEXTRACT_APP_DATA_DIR) {
    return path.resolve(process.env.TRACKEXTRACT_APP_DATA_DIR);
  }

  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "com.trackextract.desktop");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "com.trackextract.desktop");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "com.trackextract.desktop");
}

function defaultProjectRoot() {
  if (process.env.TRACKEXTRACT_PROJECT_ROOT) {
    return path.resolve(process.env.TRACKEXTRACT_PROJECT_ROOT);
  }

  const music = path.join(os.homedir(), "Music");
  const documents = path.join(os.homedir(), "Documents");
  return path.join(fs.existsSync(music) ? music : documents, "TrackExtract Projects");
}

function sanitizeFileName(value: string) {
  const invalid = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);
  const cleaned = [...path.basename(value)]
    .map((character) => (invalid.has(character) || character.charCodeAt(0) < 32 ? "-" : character))
    .join("");
  return cleaned || "audio.wav";
}

function uniqueBrowserFileName(fileName: string, usedNames: Set<string>) {
  const normalized = fileName.toLowerCase();
  if (!usedNames.has(normalized)) {
    usedNames.add(normalized);
    return fileName;
  }

  const parsed = path.parse(fileName);
  let index = 2;
  while (usedNames.has(`${parsed.name} ${index}${parsed.ext}`.toLowerCase())) {
    index += 1;
  }
  const uniqueName = `${parsed.name} ${index}${parsed.ext}`;
  usedNames.add(uniqueName.toLowerCase());
  return uniqueName;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface EngineContext {
  appDataDir: string;
  projectRoot: string;
  repoRoot: string;
  bundledModels: string;
  bundledWorkflows: string;
}

type EngineEnvelope =
  | { type: "event"; name: string; payload?: unknown }
  | { type: "result"; payload?: unknown }
  | { type: "error"; message?: string };
