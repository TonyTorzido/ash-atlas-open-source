import { expect, test } from "@playwright/experimental-ct-react";

import { HealthBarVisualStory } from "./HealthBarVisualStory.js";

const visualOutput = process.env.ASH_ATLAS_VISUAL_OUTPUT;

test("desktop bars stay green and readable on bright and dark terrain", async ({ page, mount }) => {
  await mount(<HealthBarVisualStory />);
  const fills = page.locator(".hp-bar-fill");
  await expect(fills.first()).toHaveCSS("background-image", /linear-gradient/);
  await expect(page.getByRole("progressbar", { name: "Health" }).first()).toHaveCSS(
    "height",
    "11px"
  );
  await expect(page.locator(".combat-health-track").first()).toHaveCSS("height", "9px");

  await page.getByRole("button", { name: "Damage" }).click();
  await expect(
    page
      .getByRole("region", { name: "Health transition sample" })
      .locator(".hp-bar-damage-trail[data-active='true']")
  ).toHaveCount(1);
  await page.waitForTimeout(360);
  if (visualOutput) {
    await page.screenshot({
      path: `${visualOutput}/hp-bars-desktop.png`,
      fullPage: true
    });
  }
});

test("phone dock keeps its compact health size and green language", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiProfile = "phone";
  });
  await mount(<HealthBarVisualStory phone />);
  const phoneHealth = page
    .getByRole("region", { name: "Phone health bar" })
    .getByRole("progressbar", { name: "Health" });
  await expect(phoneHealth).toHaveCSS("height", "6px");
  await expect(phoneHealth.locator(".hp-bar-fill")).toHaveCSS(
    "background-image",
    /linear-gradient/
  );
  if (visualOutput) {
    await page.screenshot({
      path: `${visualOutput}/hp-bars-phone.png`,
      fullPage: true
    });
  }
});

test("reduced motion removes trail and pulse animation", async ({ page, mount }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(<HealthBarVisualStory />);
  await expect(page.locator(".hp-bar-track.is-critical").first()).toHaveCSS(
    "animation-name",
    "none"
  );
  await page.getByRole("button", { name: "Damage" }).click();
  await expect(
    page
      .getByRole("region", { name: "Health transition sample" })
      .locator(".hp-bar-damage-trail")
  ).toHaveCSS("display", "none");
});
