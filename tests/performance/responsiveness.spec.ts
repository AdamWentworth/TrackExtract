import { expect, type Page, test } from "@playwright/test";

const marks = {
  appReady: "trackextract:app-ready",
  importStart: "trackextract:import-start",
  importFeedback: "trackextract:import-feedback",
  projectReady: "trackextract:project-ready",
  sourceCanPlay: "trackextract:source-can-play",
  sourceWaveformReady: "trackextract:source-waveform-ready",
  playbackRequested: "trackextract:playback-requested",
  playbackStarted: "trackextract:playback-started",
} as const;

const budgets = process.env.CI
  ? {
      appReady: 10_000,
      importFeedback: 500,
      projectReady: 8_000,
      sourceCanPlay: 9_000,
      sourceWaveformReady: 12_000,
      playbackStart: 1_500,
    }
  : {
      appReady: 6_000,
      importFeedback: 300,
      projectReady: 4_000,
      sourceCanPlay: 5_000,
      sourceWaveformReady: 7_000,
      playbackStart: 750,
    };

async function markTime(page: Page, name: string) {
  await page.waitForFunction((markName) => performance.getEntriesByName(markName, "mark").length > 0, name);
  return page.evaluate((markName) => {
    const entries = performance.getEntriesByName(markName, "mark");
    return entries[entries.length - 1]?.startTime ?? Number.NaN;
  }, name);
}

async function dropSilentWave(page: Page, dataBytes: number) {
  await page.locator(".drop-zone").evaluate((dropZone, byteCount) => {
    const bytes = new Uint8Array(44 + byteCount);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    const writeText = (value: string) => {
      for (const character of value) {
        view.setUint8(offset, character.charCodeAt(0));
        offset += 1;
      }
    };
    const writeUint32 = (value: number) => {
      view.setUint32(offset, value, true);
      offset += 4;
    };
    const writeUint16 = (value: number) => {
      view.setUint16(offset, value, true);
      offset += 2;
    };

    const sampleRate = 44_100;
    const channels = 2;
    const bytesPerSample = 2;
    writeText("RIFF");
    writeUint32(36 + byteCount);
    writeText("WAVE");
    writeText("fmt ");
    writeUint32(16);
    writeUint16(1);
    writeUint16(channels);
    writeUint32(sampleRate);
    writeUint32(sampleRate * channels * bytesPerSample);
    writeUint16(channels * bytesPerSample);
    writeUint16(bytesPerSample * 8);
    writeText("data");
    writeUint32(byteCount);

    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "performance-fixture.wav", { type: "audio/wav" }));
    dropZone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, dataBytes);
}

test("keeps startup, drag-drop import, waveform readiness, and playback responsive", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("Track Extract").first()).toBeVisible();

  const appReady = await markTime(page, marks.appReady);
  expect(appReady, "cold app shell readiness").toBeLessThanOrEqual(budgets.appReady);

  await dropSilentWave(page, 8 * 1024 * 1024);

  const importStart = await markTime(page, marks.importStart);
  const importFeedback = (await markTime(page, marks.importFeedback)) - importStart;
  const projectReady = (await markTime(page, marks.projectReady)) - importStart;
  const sourceCanPlay = (await markTime(page, marks.sourceCanPlay)) - importStart;
  const sourceWaveformReady = (await markTime(page, marks.sourceWaveformReady)) - importStart;

  expect(importFeedback, "visible import acknowledgement").toBeLessThanOrEqual(budgets.importFeedback);
  expect(projectReady, "8 MiB drag-drop import").toBeLessThanOrEqual(budgets.projectReady);
  expect(sourceCanPlay, "source player readiness after drop").toBeLessThanOrEqual(budgets.sourceCanPlay);
  expect(sourceWaveformReady, "source waveform readiness after drop").toBeLessThanOrEqual(budgets.sourceWaveformReady);

  const waveform = page.getByRole("button", { name: "Play performance-fixture.wav from waveform" });
  await expect(waveform).toHaveAttribute("data-waveform-state", "ready");
  await waveform.click({ position: { x: 1, y: 1 } });

  const playbackRequested = await markTime(page, marks.playbackRequested);
  const playbackStart = (await markTime(page, marks.playbackStarted)) - playbackRequested;
  expect(playbackStart, "waveform click to audio playback").toBeLessThanOrEqual(budgets.playbackStart);

  const metrics = { appReady, importFeedback, projectReady, sourceCanPlay, sourceWaveformReady, playbackStart };
  await testInfo.attach("performance-metrics", {
    body: JSON.stringify({ budgets, metrics }, null, 2),
    contentType: "application/json",
  });
  console.log(`Track Extract performance (ms): ${JSON.stringify(metrics)}`);
});
