import { expect, test } from "@playwright/experimental-ct-react";

import { FlagArrivalAuthorityStory } from "./FlagArrivalAuthorityStory.js";

test("one jump shows mobs and trees, building preserves authority, and manual jump converges once", async ({
  mount,
  page
}) => {
  await mount(<FlagArrivalAuthorityStory />);

  await page.getByRole("button", { name: "Jump to Flag B" }).click();
  await expect(page.getByLabel("current flag")).toHaveText("flag-b");
  await expect(page.getByLabel("anchor")).toHaveText("36,-105");
  await expect(page.getByLabel("mobs")).toHaveText("2");
  await expect(page.getByLabel("trees")).toHaveText("2");
  await expect(page.getByLabel("camera centers")).toHaveText("1");

  await page.getByRole("button", { name: "Build New Flag" }).click();
  await expect(page.getByLabel("catalogue"))
    .toHaveText("flag-a,flag-b,flag-new");
  await expect(page.getByLabel("current flag")).toHaveText("flag-b");
  await expect(page.getByLabel("anchor")).toHaveText("36,-105");
  await expect(page.getByLabel("camera centers")).toHaveText("1");

  await page.getByRole("button", { name: "Jump to New Flag" }).click();
  await expect(page.getByLabel("current flag")).toHaveText("flag-new");
  await expect(page.getByLabel("anchor")).toHaveText("36.001,-104.999");
  await expect(page.getByLabel("mobs")).toHaveText("2");
  await expect(page.getByLabel("trees")).toHaveText("2");
  await expect(page.getByLabel("camera centers")).toHaveText("2");
  await expect(page.getByLabel("warning")).toHaveText("none");
});
