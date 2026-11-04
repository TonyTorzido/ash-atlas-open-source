import { expect, test } from "@playwright/experimental-ct-react";
import { InventoryInteractionStory } from "./InventoryInteractionStory.js";
import { KitchenPolishStory, PartyPolishStory } from "./InventoryPartyPolishStory.js";

for (const theme of ["light", "dark"]) for (const width of [320, 390, 1280]) {
  test(`${theme} Inventory, Kitchen, and Party remain readable at ${width}px`, async ({ page, mount }, testInfo) => {
    const phone = width < 600;
    await page.evaluate((value) => document.documentElement.dataset.menuTheme = value, theme);
    await page.setViewportSize({ width, height: phone ? 844 : 900 });
    await page.evaluate((compact) => {
      document.documentElement.setAttribute("data-ui-profile", compact ? "phone" : "desktop");
      document.documentElement.setAttribute("data-layout-mode", compact ? "compact" : "expanded");
    }, phone);
    const inventory = await mount(<InventoryInteractionStory layout={phone ? "phone" : "desktop"} />);
    const rowGeometry = await page.locator(".inventory-entry-with-favorite").evaluateAll((rows) => rows.map((row) => {
      const box = row.getBoundingClientRect();
      const action = row.querySelector(".inventory-entry-row")!.getBoundingClientRect();
      const star = row.querySelector(".inventory-favorite")!.getBoundingClientRect();
      return { gap: star.left - action.right, right: box.right - star.right, width: star.width, overflow: row.scrollWidth - row.clientWidth };
    }));
    for (const row of rowGeometry) {
      expect(row.gap).toBeGreaterThanOrEqual(-1);
      expect(row.right).toBeLessThanOrEqual(1);
      expect(row.width).toBeGreaterThanOrEqual(44);
      expect(row.overflow).toBeLessThanOrEqual(1);
    }
    const favorite = page.getByRole("button", { name: "Favorite Wood", exact: true });
    await favorite.click();
    await expect(page.locator(".inventory-entry").first()).toContainText("Wood");
    await page.getByRole("button", { name: "Unfavorite Wood", exact: true }).click();
    expect(await page.locator(".inventory-carry-summary").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`inventory-${width}.png`) });
    await inventory.unmount();

    const kitchen = await mount(<KitchenPolishStory layout={phone ? "phone" : "desktop"} />);
    const raw = page.getByRole("button", { name: /Freshwater Fish/ });
    await raw.click();
    await expect(raw).toHaveAttribute("aria-pressed", "true");
    expect(await raw.evaluate((e) => {
      const copy = e.querySelector(".kitchen-picker-copy")!;
      const art = e.querySelector(".kitchen-picker-art")!;
      const mark = e.querySelector(".kitchen-selection-mark")!;
      return copy.getBoundingClientRect().left >= art.getBoundingClientRect().right && copy.getBoundingClientRect().right <= mark.getBoundingClientRect().left && e.scrollWidth <= e.clientWidth;
    })).toBe(true);
    if (phone) await expect(page.locator(".kitchen-picker-list")).toHaveCSS("overflow-y", "visible");
    await page.screenshot({ path: testInfo.outputPath(`kitchen-${width}.png`) });
    await kitchen.unmount();

    await mount(<PartyPolishStory layout={phone ? "phone" : "desktop"} />);
    await expect(page.getByText("5 open places")).toBeVisible();
    expect((await page.locator(".phone-party-roster").boundingBox())!.height).toBeLessThan(300);
    await page.getByRole("button", { name: "Invite Players", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Nearby", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create Party", exact: true }).click();
    await expect(page.getByText("3 open places")).toBeVisible();
    await expect(page.locator(".phone-party-member-command")).toHaveCount(2);
    await page.getByRole("button", { name: "Ariadne the Far Traveler actions" }).click();
    await expect(page.getByRole("button", { name: "Make Leader", exact: true })).toBeVisible();
    expect(await page.locator(".phone-party-layer .phone-destination-body, .phone-party-layer .game-app-body").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`party-${width}.png`) });
  });
}
