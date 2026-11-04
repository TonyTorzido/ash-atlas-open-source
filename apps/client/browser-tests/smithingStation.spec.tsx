import { expect, test } from "@playwright/experimental-ct-react";

import { SmithingStationStory } from "./SmithingStationStory.js";

test("Smithing eligibility refreshes from level 12 to 13 without showing maximum", async ({
  page,
  mount
}) => {
  await mount(<SmithingStationStory />);

  await expect(page.getByText("Requires character level 13.")).toBeVisible();
  await expect(page.getByText("Maximum level")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upgrade to level 13" })).toBeDisabled();

  await page.evaluate(() => window.dispatchEvent(
    new Event("smithing-story-level-thirteen")
  ));
  await expect(page.getByText("Ready to upgrade")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to level 13" })).toBeEnabled();
  await page.getByRole("button", { name: "Upgrade to level 13" }).click();
  await page.getByRole("button", { name: "Confirm Upgrade" }).click();
  await expect(page.getByText("Personal Sword upgraded to level 13.")).toBeVisible();
});
