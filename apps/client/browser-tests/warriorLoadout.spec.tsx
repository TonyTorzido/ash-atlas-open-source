import { expect, test } from "@playwright/experimental-ct-react";

import { WarriorLoadoutStory } from "./WarriorLoadoutStory.js";

test("desktop groups all Warrior class skills in the unified section", async ({ page, mount }) => {
  await mount(<WarriorLoadoutStory />);
  await page.getByRole("button", { name: "Class Skills" }).click();

  await expect(page.getByRole("heading", { name: "CLASS SKILLS" })).toBeVisible();
  await expect(page.locator(".warrior-ability-art")).toHaveCount(4);
  await expect(page.locator(".warrior-ability-pair").first()).toHaveCSS(
    "grid-template-columns",
    /.+ .+/
  );
  const concussive = page.getByRole("heading", { name: "Concussive Blow" }).locator("..");
  await concussive.getByRole("button", { name: "Equip" }).click();
  await expect(concussive.getByRole("button", { name: "Equipped" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Anger Explosion" }).locator("..").getByRole("button", { name: "Equip" })).toBeVisible();
  await expect(page.getByText(/Replace Key|Assign Key|Equip to Key/)).toHaveCount(0);
});

test("phone stacks cards within their semantic category", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiProfile = "phone";
  });
  await mount(<WarriorLoadoutStory phone />);
  await page.getByRole("button", { name: "Class Skills" }).click();

  await expect(page.locator(".warrior-ability-pair").first()).toHaveCSS(
    "grid-template-columns",
    /.+/
  );
  const firstPair = page.locator(".warrior-ability-pair").first();
  const first = await firstPair.locator(".warrior-active-card").nth(0).boundingBox();
  const second = await firstPair.locator(".warrior-active-card").nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 2);
});
