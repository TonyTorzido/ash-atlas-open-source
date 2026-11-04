import { expect, test } from "@playwright/experimental-ct-react";

import { ReconnectionLifecycleStory } from "./ReconnectionLifecycleStory.js";

test.beforeEach(async ({ page, mount }) => {
  await page.addInitScript(() => {
    window.reconnectStoryAttempts = 0;
  });
  await mount(<ReconnectionLifecycleStory />);
});

test("keeps the mounted map and open panel beneath transient recovery", async ({ page }) => {
  const shell = page.getByTestId("game-shell");
  const instanceId = await shell.getAttribute("data-instance-id");
  const selectedItem = page.getByLabel("Selected item");
  await selectedItem.fill("Selected pine stack");

  await page.evaluate(() => window.setReconnectStoryState("reconnecting"));

  await expect(page.getByText("Restoring your connection to Ash Atlas.")).toBeVisible();
  await expect(page.getByText(/session is reserved/i)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Ash Atlas map" })).toBeAttached();
  await expect(page.getByRole("complementary", { name: "Open inventory panel" })).toBeAttached();
  await expect(selectedItem).toHaveValue("Selected pine stack");
  await expect(shell).toHaveAttribute("data-instance-id", instanceId ?? "");
});

test("reconnects in place after the window ends and distinguishes offline recovery", async ({ page }) => {
  const shell = page.getByTestId("game-shell");
  const instanceId = await shell.getAttribute("data-instance-id");

  await page.evaluate(() => window.setReconnectStoryState("offline"));
  await expect(page.getByText("No connection")).toBeVisible();
  await expect(page.getByText("Ash Atlas will reconnect when you're online.")).toBeVisible();

  await page.evaluate(() => window.setReconnectStoryState("ended"));
  await page.getByRole("button", { name: "Return to Game" }).click();

  await expect(page.getByText("Reconnecting…")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.reconnectStoryAttempts)).toBe(1);
  await expect(shell).toHaveAttribute("data-instance-id", instanceId ?? "");
});
