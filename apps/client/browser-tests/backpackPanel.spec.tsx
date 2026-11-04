import { expect, test } from "@playwright/experimental-ct-react";

import { BackpackPanelStory } from "./BackpackPanelStory.js";

test("phone backpack destination keeps four usable cards in a two-column scroll surface", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute("data-ui-profile", "phone"));
  await mount(<BackpackPanelStory />);

  await expect(page.getByRole("heading", { name: "Backpacks" })).toBeVisible();
  await expect(page.locator(".backpack-progression-cards .game-app-card")).toHaveCount(4);
  await expect(page.getByText("Maximum upgrade +10")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to +1" })).toBeVisible();

  await page.screenshot({ path: "./test-results/inventory-qa/backpacks-phone.png" });
  await expect(page.getByText(/Craft new Backpack \+0 instances from the Crafting menu/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Craft Backpack +0" })).toHaveCount(0);
});
