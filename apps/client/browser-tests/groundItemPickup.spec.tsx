import { expect, test } from "@playwright/experimental-ct-react";

import { GroundItemPickupStory } from "./GroundItemPickupStory.js";

test.beforeEach(async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.groundPickupRequests = [];
  });
  await mount(<GroundItemPickupStory />);
});

test("mobile ground stack shows artwork, quantity, actions, safe dock spacing, and exact selection", async ({
  page
}) => {
  const sheet = page.getByRole("complementary", { name: "Leather actions" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("img")).toHaveAttribute("src", /leather-[^/]+\.png$/);
  await expect(sheet.getByText("Quantity: 83")).toBeVisible();
  await expect(sheet.getByRole("button")).toHaveText(["Pick Up", "Pick Up All", "Cancel"]);

  const sheetBox = await sheet.boundingBox();
  const dockBox = await page.getByTestId("phone-dock").boundingBox();
  if (!sheetBox || !dockBox) throw new Error("Pickup sheet or phone dock is not visible");
  expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(dockBox.y);

  await sheet.getByRole("button", { name: "Pick Up", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pick up Leather" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("img")).toHaveAttribute("src", /leather-[^/]+\.png$/);
  await expect(dialog.getByText("Available: 83")).toBeVisible();
  const slider = dialog.getByRole("slider", { name: "Pickup amount slider" });
  const bounds = await slider.boundingBox();
  if (!bounds) throw new Error("Pickup quantity slider is not visible");
  await page.mouse.click(bounds.x + bounds.width * 0.29, bounds.y + bounds.height / 2);
  const selected = Number(await slider.inputValue());
  expect(selected).toBeGreaterThanOrEqual(24);
  expect(selected).toBeLessThanOrEqual(26);
  await dialog.getByRole("button", { name: `Pick Up ${selected}` }).click();
  expect(await page.evaluate(() => window.groundPickupRequests)).toEqual([selected]);

  await sheet.getByRole("button", { name: "Pick Up All" }).click();
  expect(await page.evaluate(() => window.groundPickupRequests)).toEqual([selected, "all"]);
});
