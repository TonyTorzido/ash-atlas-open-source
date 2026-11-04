import { expect, test } from "@playwright/experimental-ct-react";

import { ManorDecorationsStory } from "./ManorDecorationsStory.js";

for (const [name, viewport, layout] of [
  ["desktop", { width: 1280, height: 900 }, "desktop"],
  ["phone 375x812", { width: 375, height: 812 }, "phone"]
] as const) {
  test.describe(name, () => {
    test.use({ viewport, ...(layout === "phone" ? { hasTouch: true, isMobile: true } : {}) });

    test("Decorations opens a visible menu that stays open and choosing one starts placement preview", async ({
      mount,
      page
    }) => {
      await mount(<ManorDecorationsStory layout={layout} />);
      const button = page.getByRole("button", { name: "Decorations" });
      await expect(button).toBeVisible();
      const buttonBox = (await button.boundingBox())!;
      // Hit-test the far edge: the utility hotbar rails must not sit over the button.
      const edge = { x: buttonBox.width - 6, y: buttonBox.height / 2 };
      await (layout === "phone" ? button.tap({ position: edge }) : button.click({ position: edge }));
      const menu = page.locator(".manor-decoration-menu-prompt");
      await expect(menu).toBeVisible();
      await expect(page.getByTestId("decoration-requests")).toHaveText("1");
      const choice = page.locator(".manor-decoration-menu-choice").first();
      await expect(choice).toBeVisible();
      await page.waitForTimeout(600);
      await expect(menu).toBeVisible();
      const box = await choice.boundingBox();
      const viewportSize = page.viewportSize()!;
      expect(box && box.y >= 0 && box.y + box.height <= viewportSize.height).toBe(true);
      await (layout === "phone" ? choice.tap() : choice.click());
      await expect(menu).toHaveCount(0);
      await expect(page.locator(".manor-decoration-runtime.preview"))
        .toBeVisible();
    });
  });
}
