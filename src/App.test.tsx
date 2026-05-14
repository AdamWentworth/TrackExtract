import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("renders import, workflow, queue, preview, and export surfaces", async () => {
    render(<App />);

    expect(await screen.findByText("TrackExtract")).toBeInTheDocument();
    expect(screen.getByText("Import")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workflow" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Model Setup" })).toBeInTheDocument();
    expect(screen.getByText("Manage models")).toBeInTheDocument();
    expect(screen.getByText("Queue")).toBeInTheDocument();
    expect(screen.getByText("Stem Preview")).toBeInTheDocument();
    expect(screen.getByText("Render Options")).toBeInTheDocument();
    expect(screen.getByText("Export")).toBeInTheDocument();
  });

  it("renders editable model render options", async () => {
    render(<App />);

    expect(await screen.findByText("Render Options")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Auto")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("1")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("1"), { target: { value: "2" } });

    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
  });

  it("shows mocked bootstrap data after startup", async () => {
    render(<App />);

    expect(await screen.findByText("Quick Vocal Split")).toBeInTheDocument();
    expect((await screen.findAllByText("Demucs HTDemucs Vocals / Instrumental")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  it("shows downloadable vocal cleanup models and marks them ready after install", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Clean Lead Vocal Chain"));
    fireEvent.click(await screen.findByText("Model library"));
    const dialog = await screen.findByRole("dialog", { name: "Model Library" });
    const library = within(dialog);
    fireEvent.change(library.getByLabelText("Filter models"), { target: { value: "MDX23C" } });
    const mdx23cTitle = (await library.findAllByText("UVR MDX23C InstVoc HQ")).find((element) =>
      element.closest("article"),
    );
    if (!mdx23cTitle) {
      throw new Error("Expected UVR MDX23C row in the model library.");
    }
    expect(mdx23cTitle).toBeInTheDocument();

    const mdx23cRow = mdx23cTitle.closest("article");
    expect(mdx23cRow).not.toBeNull();
    fireEvent.click(within(mdx23cRow as HTMLElement).getByText("Install"));

    expect(await screen.findByText("UVR MDX23C InstVoc HQ installed")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(mdx23cRow as HTMLElement).getByText("Ready")).toBeInTheDocument();
    });
  });

  it("selects full stem workflow models", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Full 6-Stem Split"));

    expect((await screen.findAllByText("Demucs HTDemucs 6 Stem Split")).length).toBeGreaterThan(0);
  });

  it("shows layered vocal cleanup as part of the cleanup workflow", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Clean Lead Vocal Chain"));

    expect(await screen.findByText("UVR MDX-NET Karaoke 2 ONNX")).toBeInTheDocument();
  });

  it("filters denoise models in the model manager", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Model library"));
    fireEvent.change(await screen.findByLabelText("Filter models"), { target: { value: "denoise" } });

    expect((await screen.findAllByText("UVR DeNoise")).length).toBeGreaterThan(0);
  });

  it("uses status, task, and backend filters inside the full model library", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Model library"));
    const dialog = await screen.findByRole("dialog", { name: "Model Library" });
    const library = within(dialog);

    fireEvent.change(library.getByLabelText("Task filter"), { target: { value: "vocal_dereverb" } });
    fireEvent.change(library.getByLabelText("Backend filter"), { target: { value: "python-engine" } });

    expect(await library.findByText("Reverb HQ By FoxJoy ONNX")).toBeInTheDocument();
    expect(library.queryByText("Demucs HTDemucs Vocals / Instrumental")).not.toBeInTheDocument();

    fireEvent.change(library.getByLabelText("Status filter"), { target: { value: "installable" } });
    expect(await library.findByText("Reverb HQ By FoxJoy ONNX")).toBeInTheDocument();

    fireEvent.click(library.getByText("Clear"));
    expect(await library.findByText("Demucs HTDemucs Vocals / Instrumental")).toBeInTheDocument();
  });

  it("keeps the full model registry inside the model manager", async () => {
    render(<App />);

    await screen.findByText("Manage models");
    expect(screen.queryByText("UVR MDX-NET 9482 ONNX")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Manage models"));
    const dialog = await screen.findByRole("dialog", { name: "Model Library" });
    const library = within(dialog);
    fireEvent.change(library.getByLabelText("Filter models"), { target: { value: "denoise" } });

    expect(await library.findByText("UVR DeNoise")).toBeInTheDocument();
    expect(library.queryByText("UVR MDX-NET 9482 ONNX")).not.toBeInTheDocument();
  });

  it("imports browser mock audio from the drop-zone button", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Drop audio here"));

    expect((await screen.findAllByText("Artist - Browser Demo")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/1 source file .* 0 stems/)).toBeInTheDocument();
  });

  it("runs the browser mock separation and shows generated stems", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Drop audio here"));
    const runButton = await screen.findByText("Run workflow");
    await waitFor(() => expect(runButton).not.toBeDisabled());
    fireEvent.click(runButton);

    expect(await screen.findByText("Separation complete")).toBeInTheDocument();
    expect((await screen.findAllByText("Vocals")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Instrumental")).length).toBeGreaterThan(0);
  });

  it("clears generated stems and source audio from the workspace", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByText("Drop audio here"));
    const runButton = await screen.findByText("Run workflow");
    await waitFor(() => expect(runButton).not.toBeDisabled());
    fireEvent.click(runButton);
    expect(await screen.findByText("Separation complete")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear stems" }));
    expect(await screen.findByText("Generated stems cleared")).toBeInTheDocument();
    expect(screen.getByText("Generated stems will appear here.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear source" }));
    expect(await screen.findByText("Source audio cleared")).toBeInTheDocument();
    expect(await screen.findByText(/0 source files .* 0 stems/)).toBeInTheDocument();
    expect(screen.getByText("No jobs queued yet")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it("opens model source links in the browser runtime", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<App />);

    fireEvent.click(await screen.findByText("Model library"));
    fireEvent.click((await screen.findAllByTitle("Open model source"))[0]);

    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining("github.com"), "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("refreshes the model registry from the toolbar action", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Model library"));
    fireEvent.click(await screen.findByText("Refresh"));

    expect(await screen.findByText("Model registry refreshed")).toBeInTheDocument();
  });

  it("syncs audio-separator catalog models from the model manager", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Model library"));
    fireEvent.click(await screen.findByText("Sync audio-separator"));

    expect(await screen.findByText("audio-separator catalog synced")).toBeInTheDocument();
    expect(await screen.findByText("Mock audio-separator RoFormer")).toBeInTheDocument();
  });

  it("keeps raw Demucs weight assets marked as needing model definitions", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Model library"));
    const dialog = await screen.findByRole("dialog", { name: "Model Library" });
    const library = within(dialog);
    fireEvent.change(library.getByLabelText("Filter models"), { target: { value: "ebf34a2d" } });

    const demucsWeightTitle = (await library.findAllByText("ebf34a2d")).find((element) => element.closest("article"));
    if (!demucsWeightTitle) {
      throw new Error("Expected ebf34a2d row in the model library.");
    }
    const demucsWeightRow = demucsWeightTitle.closest("article");
    expect(demucsWeightRow).not.toBeNull();
    fireEvent.click(within(demucsWeightRow as HTMLElement).getByText("Install"));

    expect(await screen.findByText("ebf34a2d installed")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(demucsWeightRow as HTMLElement).getByText("Installed · needs model definition"),
      ).toBeInTheDocument();
    });
  });

  it("saves the current setup as a custom workflow", async () => {
    render(<App />);

    expect((await screen.findAllByText("Demucs HTDemucs Vocals / Instrumental")).length).toBeGreaterThan(0);
    fireEvent.change(await screen.findByLabelText("Custom workflow name"), { target: { value: "My Vocal Chain" } });
    fireEvent.click(await screen.findByText("Save workflow"));

    expect(await screen.findByText("Saved workflow My Vocal Chain")).toBeInTheDocument();
    expect(await screen.findByText("My Vocal Chain")).toBeInTheDocument();
  });
});
