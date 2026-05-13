import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

const bootstrap = {
  projectRoot: "/tmp/TrackExtract Projects",
  appDataDir: "/tmp/TrackExtract",
  modelRegistryPath: "/tmp/TrackExtract/models.json",
  models: [
    {
      id: "demucs_htdemucs_vocals_instrumental",
      displayName: "Demucs HTDemucs Vocals / Instrumental",
      backend: "pytorch-worker",
      tasks: ["vocals_instrumental"],
      stems: ["Vocals", "Instrumental"],
      sampleRate: 44100,
      quality: "balanced",
      version: "demucs-4.0.1/htdemucs",
      installed: true,
      path: "workers/demucs_worker.py",
      downloadUrl: "https://pypi.org/project/demucs/",
      sourceUrl: "https://github.com/facebookresearch/demucs",
      license: "MIT",
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

    expect((await screen.findAllByText("Demucs HTDemucs Vocals / Instrumental")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  it("shows downloadable vocal cleanup models and marks them backend-pending after install", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Clean Lead Vocal"));
    expect(await screen.findByText("UVR MDX23C InstVoc HQ")).toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Install")[0]);

    expect(await screen.findByText("UVR MDX23C InstVoc HQ installed")).toBeInTheDocument();
    expect(await screen.findByText("Installed · backend pending")).toBeInTheDocument();
  });

  it("filters full stem models when the full split task is selected", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Full Stem Split"));

    expect(await screen.findByText("Demucs HTDemucs 6 Stem Split")).toBeInTheDocument();
  });

  it("filters layered vocal cleanup models", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Remove Layered Vocals"));

    expect(await screen.findByText("UVR MDX-NET Karaoke 2 ONNX")).toBeInTheDocument();
  });

  it("filters denoise models", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Denoise Vocal"));

    expect(await screen.findByText("UVR DeNoise")).toBeInTheDocument();
  });

  it("imports browser mock audio from the drop-zone button", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Drop audio here"));

    expect(await screen.findByText("Artist - Browser Demo")).toBeInTheDocument();
    expect(await screen.findByText("1 source file")).toBeInTheDocument();
  });

  it("runs the browser mock separation and shows generated stems", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Drop audio here"));
    const runButton = await screen.findByText("Run separation");
    await waitFor(() => expect(runButton).not.toBeDisabled());
    fireEvent.click(runButton);

    expect(await screen.findByText("Separation complete")).toBeInTheDocument();
    expect((await screen.findAllByText("Vocals")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Instrumental")).length).toBeGreaterThan(0);
  });

  it("opens model source links in the browser runtime", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<App />);

    fireEvent.click((await screen.findAllByTitle("Open model source"))[0]);

    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining("github.com"), "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("refreshes the model registry from the toolbar action", async () => {
    render(<App />);

    fireEvent.click(await screen.findByTitle("Refresh model registry"));

    expect(await screen.findByText("Model registry refreshed")).toBeInTheDocument();
  });

  it("keeps backend-pending installed models from running separation", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Clean Lead Vocal"));
    fireEvent.click(await screen.findByText("Drop audio here"));
    await screen.findByText("Artist - Browser Demo");

    const installButtons = screen.queryAllByText("Install");
    if (installButtons.length > 0) {
      fireEvent.click(installButtons[0]);
      await screen.findByText(/installed$/);
    }

    await waitFor(() => expect(screen.getByText("Run separation")).toBeDisabled());
  });
});
