/* global document, process, setTimeout, window */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const outputRoot = resolve(process.env.TRACKEXTRACT_DEMO_MEDIA_OUT ?? ".artifacts/demo-media/trackextract");
const screenshotsDir = resolve(outputRoot, "screenshots");
const videosDir = resolve(outputRoot, "videos");
const manifestPath = resolve(outputRoot, "manifest.json");
const themes = parseThemes(process.env.TRACKEXTRACT_DEMO_THEMES ?? "dark,light");

const viewport = {
  key: "desktop",
  width: Number(process.env.TRACKEXTRACT_DEMO_WIDTH ?? 1760),
  height: Number(process.env.TRACKEXTRACT_DEMO_HEIGHT ?? 1100),
};

const captured = {
  generatedAt: new Date().toISOString(),
  screenshots: [],
  videos: [],
};

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  rmSync(screenshotsDir, { recursive: true, force: true });
  rmSync(videosDir, { recursive: true, force: true });
  mkdirSync(screenshotsDir, { recursive: true });
  mkdirSync(videosDir, { recursive: true });
});

test("captures TrackExtract feature screenshots", async ({ browser }) => {
  for (const theme of themes) {
    await captureScreenshot(browser, theme, "workspace", async (page) => {
      await prepareApp(page);
      await importDemoAudio(page);
      await selectWorkflow(page, "Full 6-Stem Split");
      await expect(page.locator(".project-summary strong")).toHaveText("Artist - Browser Demo");
      await expect(page.locator(".source-panel")).toBeVisible();
    });

    await captureScreenshot(browser, theme, "rendered-stems", async (page) => {
      await prepareCompletedSixStemRun(page);
      await smoothScrollTo(page, page.locator(".preview-panel"), 700, "start");
      await expect(page.locator(".stem-row")).toHaveCount(6);
    });

    await captureScreenshot(browser, theme, "model-library", async (page) => {
      await prepareApp(page);
      await openModelLibrary(page);
      await fillWithPointer(page, page.getByLabel("Filter models"), "uvr");
      await selectWithPointer(page, page.getByLabel("Status filter"), "Installable");
      await expect(page.getByText("Model Library")).toBeVisible();
      await expect(page.locator(".library-model-row").first()).toBeVisible();
    });

    await captureScreenshot(browser, theme, "cleanup-chain", async (page) => {
      await prepareApp(page);
      await importDemoAudio(page);
      await selectWorkflow(page, "Clean Lead Vocal Chain");
      await expect(page.locator(".run-panel")).toContainText("5-step workflow");
      await expect(page.locator(".run-panel")).toContainText(/need setup|all models ready/i);
      await smoothScrollTo(page, page.locator(".model-summary-panel"), 500);
    });
  }
});

test("records TrackExtract demo videos", async ({ browser }) => {
  for (const theme of themes) {
    await recordVideo(browser, theme, "import-run", async (page) => {
      await prepareApp(page);
      await pause(450);
      await importDemoAudio(page);
      await selectWorkflow(page, "Full 6-Stem Split", 550);
      await clickWithPointer(page, page.getByRole("button", { name: "Run workflow" }), 700);
      await waitForStems(page, 6);
      await smoothScrollTo(page, page.locator(".preview-panel"), 900);
      await clickWithPointer(page, page.locator(".stem-row").filter({ hasText: "Vocals" }).getByText("Solo"), 650);
    });

    await recordVideo(browser, theme, "model-library", async (page) => {
      await prepareApp(page);
      await openModelLibrary(page, 650);
      await fillWithPointer(page, page.getByLabel("Filter models"), "vocal", 550);
      await selectWithPointer(page, page.getByLabel("Status filter"), "Installable", 650);
      await selectWithPointer(page, page.getByLabel("Task filter"), "Clean Lead Vocal", 650);
      await smoothScrollTo(page, page.locator(".library-model-row").nth(3), 850);
      await clickWithPointer(
        page,
        page.locator(".library-model-row").first().getByRole("button", { name: "Install" }),
        800,
      );
      await clickWithPointer(
        page,
        page.locator(".library-model-row").first().getByRole("button", { name: "Use" }),
        750,
      );
    });

    await recordVideo(browser, theme, "cleanup-chain", async (page) => {
      await prepareApp(page);
      await importDemoAudio(page);
      await selectWorkflow(page, "Clean Lead Vocal Chain", 650);
      await clickIfVisible(page, page.getByRole("button", { name: "Install workflow models" }), 900);
      await clickWithPointer(page, page.getByRole("button", { name: "Run workflow" }), 700);
      await waitForAnyStem(page);
      await smoothScrollTo(page, page.locator(".queue-panel"), 800);
      await smoothScrollTo(page, page.locator(".preview-panel"), 1000);
    });

    await recordVideo(browser, theme, "preview-export", async (page) => {
      await prepareCompletedSixStemRun(page);
      await smoothScrollTo(page, page.locator(".preview-panel"), 800);
      await clickWithPointer(page, page.locator(".stem-row").filter({ hasText: "Drums" }).getByText("Mute"), 600);
      await clickWithPointer(page, page.locator(".stem-row").filter({ hasText: "Bass" }).getByText("Solo"), 600);
      await smoothScrollTo(page, page.locator(".export-panel"), 700);
      await selectWithPointer(page, page.locator(".export-format-field select"), "MP3 · 320 kbps sharing", 600);
      await clickWithPointer(page, page.getByRole("button", { name: "Export selected" }), 700);
      await expect(page.getByText(/Exported 6 MP3 stems/i)).toBeVisible();
    });
  }
});

test.afterAll(() => {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(captured, null, 2)}\n`);
});

async function captureScreenshot(browser, theme, name, prepare) {
  const context = await newDemoContext(browser, theme);
  const page = await context.newPage();
  await prepare(page);
  await waitForVisualReady(page);

  const fileName = `trackextract-${theme}-${name}-${viewport.key}.png`;
  const path = resolve(screenshotsDir, fileName);
  await page.screenshot({ path, fullPage: false });
  captured.screenshots.push({
    name,
    theme,
    viewport: viewport.key,
    path: relativeArtifactPath(path),
  });

  await context.close();
}

async function recordVideo(browser, theme, name, flow) {
  const context = await newDemoContext(browser, theme, {
    dir: videosDir,
    size: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  await flow(page);
  await waitForVisualReady(page);
  await pause(450);

  const video = page.video();
  await page.close();
  await context.close();

  const fileName = `trackextract-${theme}-${name}-${viewport.key}.webm`;
  const path = resolve(videosDir, fileName);
  const temporaryPath = await video?.path().catch(() => undefined);
  await video?.saveAs(path);
  if (temporaryPath && temporaryPath !== path) {
    rmSync(temporaryPath, { force: true });
  }
  captured.videos.push({
    name,
    theme,
    viewport: viewport.key,
    path: relativeArtifactPath(path),
  });
}

async function newDemoContext(browser, theme, recordVideo) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    recordVideo,
  });
  await context.addInitScript((themeMode) => {
    window.localStorage.setItem("trackextract_theme", themeMode);
  }, theme);
  return context;
}

async function prepareApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await installPointerOverlay(page);
  await expect(page.getByText("Drop audio here")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run workflow" })).toBeDisabled();
  await waitForVisualReady(page);
}

async function prepareCompletedSixStemRun(page) {
  await prepareApp(page);
  await importDemoAudio(page);
  await selectWorkflow(page, "Full 6-Stem Split");
  await clickWithPointer(page, page.getByRole("button", { name: "Run workflow" }), 450);
  await waitForStems(page, 6);
}

async function importDemoAudio(page) {
  await clickWithPointer(page, page.getByText("Drop audio here"), 550);
  await expect(page.locator(".project-summary strong")).toHaveText("Artist - Browser Demo");
  await expect(page.locator(".source-panel")).toBeVisible();
}

async function selectWorkflow(page, workflowName, pauseMs = 350) {
  await clickWithPointer(page, page.locator(".workflow-option").filter({ hasText: workflowName }), pauseMs);
}

async function openModelLibrary(page, pauseMs = 350) {
  await clickWithPointer(page, page.getByRole("button", { name: "Manage models" }), pauseMs);
  await expect(page.getByRole("dialog", { name: "Model Library" })).toBeVisible();
}

async function waitForStems(page, count) {
  await expect(page.locator(".stem-row")).toHaveCount(count, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Run workflow" })).toBeEnabled({ timeout: 20_000 });
  await waitForVisualReady(page);
}

async function waitForAnyStem(page) {
  await expect(page.locator(".stem-row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Run workflow" })).toBeEnabled({ timeout: 30_000 });
  await waitForVisualReady(page);
}

async function clickIfVisible(page, locator, pauseMs = 450) {
  if (await locator.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await clickWithPointer(page, locator, pauseMs);
    return true;
  }
  return false;
}

async function clickWithPointer(page, locator, pauseMs = 450) {
  const target = locator.first();
  await target.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => undefined);
  await expect(target).toBeVisible();
  const point = await centerPoint(target);
  await showPointer(page, point.x, point.y);
  await page.mouse.move(point.x, point.y, { steps: 10 });
  await target.click({ timeout: 10_000 });
  await pulsePointer(page, point.x, point.y);
  await waitForVisualReady(page);
  await pause(pauseMs);
}

async function fillWithPointer(page, locator, value, pauseMs = 450) {
  const target = locator.first();
  await target.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => undefined);
  await expect(target).toBeVisible();
  const point = await centerPoint(target);
  await showPointer(page, point.x, point.y);
  await page.mouse.move(point.x, point.y, { steps: 10 });
  await target.click({ timeout: 10_000 });
  await target.fill(value);
  await pulsePointer(page, point.x, point.y);
  await waitForVisualReady(page);
  await pause(pauseMs);
}

async function selectWithPointer(page, locator, label, pauseMs = 450) {
  const target = locator.first();
  await target.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => undefined);
  await expect(target).toBeVisible();
  const point = await centerPoint(target);
  await showPointer(page, point.x, point.y);
  await page.mouse.move(point.x, point.y, { steps: 10 });
  await target.selectOption({ label }, { timeout: 10_000 });
  await pulsePointer(page, point.x, point.y);
  await waitForVisualReady(page);
  await pause(pauseMs);
}

async function smoothScrollTo(page, locator, pauseMs = 700, block = "center") {
  const target = locator.first();
  await expect(target).toBeVisible();
  await target.evaluate((element, scrollBlock) => {
    element.scrollIntoView({ behavior: "smooth", block: scrollBlock, inline: "nearest" });
  }, block);
  await pause(pauseMs);
  await waitForVisualReady(page);
}

async function waitForVisualReady(page) {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  await page
    .waitForFunction(
      () => {
        const images = [...document.images].filter((image) => {
          const rect = image.getBoundingClientRect();
          return (
            rect.width > 8 &&
            rect.height > 8 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          );
        });
        return images.every((image) => image.complete);
      },
      { timeout: 12_000 },
    )
    .catch(() => undefined);
  await pause(150);
}

async function installPointerOverlay(page) {
  const css = `
    .demo-pointer {
      position: fixed;
      left: 0;
      top: 0;
      z-index: 2147483647;
      width: 24px;
      height: 28px;
      pointer-events: none;
      transform: translate(-999px, -999px);
      transition: transform 220ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease;
      opacity: 0;
      filter: drop-shadow(0 2px 2px rgba(0,0,0,0.72));
    }
    .demo-pointer svg {
      display: block;
      width: 24px;
      height: 28px;
    }
    .demo-pointer.active {
      opacity: 1;
    }
    .demo-pointer.tap::after {
      content: "";
      position: absolute;
      left: 1px;
      top: 1px;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.72);
      border-radius: 999px;
      animation: demo-cursor-pulse 360ms ease-out;
    }
    @keyframes demo-cursor-pulse {
      from {
        opacity: 0.95;
        transform: scale(0.45);
      }
      to {
        opacity: 0;
        transform: scale(1.7);
      }
    }
  `;

  await page
    .evaluate((styleText) => {
      if (!document.getElementById("demo-pointer-style")) {
        const style = document.createElement("style");
        style.id = "demo-pointer-style";
        style.textContent = styleText;
        document.head.append(style);
      }

      if (!document.querySelector(".demo-pointer")) {
        const pointer = document.createElement("div");
        pointer.className = "demo-pointer";
        pointer.setAttribute("aria-hidden", "true");
        pointer.innerHTML = `
        <svg viewBox="0 0 24 28" aria-hidden="true">
          <path d="M3 2.75v19.2l5.58-5.23 3 7.17 3.18-1.34-2.88-6.9h7.87L3 2.75Z" fill="#fff" stroke="#050505" stroke-width="1.65" stroke-linejoin="round"/>
          <path d="M5.1 7.52v9.47l3.98-3.73 3.25 7.75" fill="none" stroke="#fff" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round" opacity="0.65"/>
        </svg>
      `;
        document.body.append(pointer);
      }
    }, css)
    .catch(() => undefined);
}

async function showPointer(page, x, y) {
  await installPointerOverlay(page);
  await page.evaluate(
    ({ x, y }) => {
      const pointer = document.querySelector(".demo-pointer");
      if (!pointer) {
        return;
      }
      pointer.classList.remove("tap");
      pointer.classList.add("active");
      pointer.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
    },
    { x, y },
  );
  await pause(150);
}

async function pulsePointer(page, x, y) {
  await installPointerOverlay(page);
  await page.evaluate(
    ({ x, y }) => {
      const pointer = document.querySelector(".demo-pointer");
      if (!pointer) {
        return;
      }
      pointer.classList.remove("tap");
      void pointer.getBoundingClientRect();
      pointer.classList.add("tap");
      pointer.classList.add("active");
      pointer.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
      window.setTimeout(() => pointer.classList.remove("tap"), 190);
    },
    { x, y },
  );
  await pause(220);
}

async function centerPoint(locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Could not measure locator for demo pointer.");
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function parseThemes(value) {
  const selected = value
    .split(",")
    .map((theme) => theme.trim())
    .filter(Boolean);
  const valid = selected.filter((theme) => theme === "dark" || theme === "light");
  return valid.length > 0 ? valid : ["dark"];
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relativeArtifactPath(path) {
  return path.replace(`${process.cwd()}/`, "");
}
