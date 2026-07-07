import { defineConfig } from "@playwright/test";

const demoPort = Number(process.env.TRACKEXTRACT_DEMO_MEDIA_PORT ?? 4194);
const baseURL = process.env.TRACKEXTRACT_DEMO_MEDIA_BASE_URL ?? `http://127.0.0.1:${demoPort}`;
const skipServer =
  process.env.TRACKEXTRACT_DEMO_MEDIA_SKIP_SERVER === "1" || process.env.TRACKEXTRACT_DEMO_MEDIA_SKIP_SERVER === "true";

export default defineConfig({
  testDir: "./tests/demo-media",
  testMatch: "**/*.playwright.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: Number(process.env.TRACKEXTRACT_DEMO_MEDIA_TEST_TIMEOUT_MS ?? 210_000),
  expect: {
    timeout: Number(process.env.TRACKEXTRACT_DEMO_MEDIA_EXPECT_TIMEOUT_MS ?? 20_000),
  },
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: skipServer
    ? undefined
    : {
        command: `npm run dev:browser -- --host 127.0.0.1 --port ${demoPort}`,
        url: baseURL,
        reuseExistingServer:
          process.env.TRACKEXTRACT_DEMO_MEDIA_REUSE_SERVER === "1" ||
          process.env.TRACKEXTRACT_DEMO_MEDIA_REUSE_SERVER === "true",
        timeout: Number(process.env.TRACKEXTRACT_DEMO_MEDIA_SERVER_TIMEOUT_MS ?? 120_000),
      },
});
