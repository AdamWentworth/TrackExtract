import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async () => vi.fn()),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const bootstrap = {
  projectRoot: "/tmp/TrackExtract Projects",
  appDataDir: "/tmp/TrackExtract",
  modelRegistryPath: "/tmp/TrackExtract/models.json",
  models: [
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
  ],
  currentProject: null,
  jobs: [],
};

describe("TrackExtract app", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((command: string) => {
      if (command === "bootstrap_app") {
        return Promise.resolve(bootstrap);
      }
      if (command === "list_models" || command === "get_jobs") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });
  });

  it("renders import, model, queue, preview, and export surfaces", async () => {
    render(<App />);

    expect(await screen.findByText("TrackExtract")).toBeInTheDocument();
    expect(screen.getByText("Import")).toBeInTheDocument();
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByText("Queue")).toBeInTheDocument();
    expect(screen.getByText("Stem Preview")).toBeInTheDocument();
    expect(screen.getByText("Export")).toBeInTheDocument();
  });

  it("shows mocked bootstrap data after startup", async () => {
    render(<App />);

    expect((await screen.findAllByText("Stub Vocals / Instrumental")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });
});
