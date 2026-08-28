import { expect, test } from "@playwright/test";

test("imports audio and completes the default workflow in the production browser build", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Track Extract").first()).toBeVisible();
  await page.getByText("Drop audio here").click();
  await expect(page.getByText(/1 source file .* 0 stems/)).toBeVisible();

  const runButton = page.getByRole("button", { name: "Run workflow" });
  await expect(runButton).toBeEnabled();
  await runButton.click();

  await expect(page.getByText("Separation complete", { exact: true })).toBeVisible();
  await expect(page.getByText(/2 stems/).first()).toBeVisible();
  await expect(page.getByText("Vocals").first()).toBeVisible();
  await expect(page.getByText("Instrumental").first()).toBeVisible();
});
