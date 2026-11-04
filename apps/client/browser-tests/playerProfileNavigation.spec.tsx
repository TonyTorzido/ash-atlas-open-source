import { expect, test } from "@playwright/experimental-ct-react";

import { PlayerProfileNavigationStory } from "./PlayerProfileNavigationStory.js";

test("Realm General View Profile preserves stable identity through menu dismissal", async ({
  page,
  mount
}) => {
  await page.route("http://profile.test/api/social/player/**", async (route) => {
    const playerId = route.request().url().split("/").at(-1)!;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        player: {
          playerId,
          displayName: "Twin Name",
          portrait: { kind: "player_sprite", displayColor: "#38bdf8" },
          online: true,
          relationship: { friendship: "none", enemyMarkedByViewer: false }
        }
      })
    });
  });
  await mount(<PlayerProfileNavigationStory />);

  await page.getByRole("button", { name: "Open Realm General Player One" }).click();
  await page.getByRole("button", { name: "View Profile" }).click();
  await expect(page.getByTestId("profile-player-id"))
    .toHaveText("00000000-0000-4000-8000-000000000002");
  await expect(page.getByLabel(/Actions for/)).toHaveCount(0);

  await page.getByRole("button", { name: "Open Realm General Player Two" }).click();
  await page.getByRole("button", { name: "View Profile" }).click();
  await expect(page.getByTestId("profile-player-id"))
    .toHaveText("00000000-0000-4000-8000-000000000003");
});
