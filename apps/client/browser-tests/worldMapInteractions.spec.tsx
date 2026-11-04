import { expect, test } from "@playwright/experimental-ct-react";

import { WorldMapInteractionStory } from "./WorldMapInteractionStory.js";

test("single map-object clicks present one menu before authority commits", async ({ mount, page }) => {
  await mount(<WorldMapInteractionStory />);

  await page.getByTestId("flag").click();
  await expect(page.getByTestId("pending")).toHaveText("flag");
  await expect(page.getByTestId("menu")).toHaveText("flag");
  await expect(page.getByTestId("presentation-state")).toHaveText("visible");
  const provisionalPanel = await page.locator(".game-compact-prompt").elementHandle();
  expect(provisionalPanel).not.toBeNull();
  await expect(page.getByTestId("menu-count")).toHaveText("0");
  await expect(page.getByTestId("menu-count")).toHaveText("1", { timeout: 1_000 });
  await expect(page.getByTestId("presentation-state")).toHaveText("committed");
  expect(await provisionalPanel!.evaluate((element) => element.isConnected)).toBe(true);

  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByTestId("tree").click();
  await expect(page.getByTestId("pending")).toHaveText("tree");
  await expect(page.getByTestId("menu")).toHaveText("tree", { timeout: 1_000 });
  await expect(page.getByTestId("menu-count")).toHaveText("1");
});

test("double clicks on representative objects move once without interaction", async ({ mount, page }) => {
  await mount(<WorldMapInteractionStory />);

  for (const kind of ["flag", "tree", "mob", "dropped_item"] as const) {
    await page.getByTestId(kind).dblclick();
    await expect(page.getByTestId("pending")).toHaveText("none");
    if (kind === "flag") {
      await expect(page.locator(".game-compact-prompt"))
        .toHaveAttribute("data-world-target-presentation", "exiting");
    }
    await expect(page.getByTestId("menu")).toHaveText("none", { timeout: 1_000 });
    await expect(page.getByTestId("menu-count")).toHaveText("0");
    await expect(page.getByTestId("movement-count")).toHaveText("1");
    await page.getByRole("button", { name: "Reset" }).click();
  }
});
