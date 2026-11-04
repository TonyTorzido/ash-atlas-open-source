import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";

import { CityWarehouseStory } from "./CityWarehouseStory.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.cityWarehouseActions = [];
  });
});

test("desktop keeps both panes visible and applies the authoritative donation", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(<CityWarehouseStory layout="desktop" />);
  await expect(page.getByRole("region", { name: "Player Inventory" })).toBeVisible();
  await expect(page.getByRole("region", { name: "City Warehouse" })).toBeVisible();
  await expect(page.getByRole("listitem", { name: /Stone, quantity 12/ })).toBeVisible();

  await donateFiveWood(page);
  await expect(page.getByRole("button", { name: /Wood, quantity 15/ })).toBeVisible();
  await expect(page.getByRole("listitem", { name: /Wood, quantity 5/ })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Donated 5 Wood to the City Warehouse."
  );
  expect(await overflowMetrics(page, ".city-warehouse-panel")).toEqual({
    documentHorizontal: false,
    elementHorizontal: false
  });
});

test("phone confirmation fits, tabs update, and content stays above the footer", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<CityWarehouseStory layout="phone" />);
  await expect(page.getByRole("region", { name: "Player Inventory" })).toBeVisible();
  await expect(page.getByRole("region", { name: "City Warehouse" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to Game" })).toHaveCount(0);

  await page.getByRole("button", { name: /Wood, quantity 20/ }).click();
  await page.getByRole("button", { name: "Donate", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Donate quantity" }).fill("5");
  await page.getByRole("button", { name: "Donate 5" }).click();
  const confirmation = page.getByRole("dialog", { name: "Donate 5 Wood?" });
  const confirmationBox = await confirmation.boundingBox();
  expect(confirmationBox).not.toBeNull();
  expect(confirmationBox!.x).toBeGreaterThanOrEqual(0);
  expect(confirmationBox!.x + confirmationBox!.width).toBeLessThanOrEqual(390);
  expect(confirmationBox!.y + confirmationBox!.height).toBeLessThanOrEqual(844);
  await confirmation.getByRole("button", { name: "Donate 5" }).click();

  await page.getByRole("button", { name: "City Warehouse" }).click();
  await expect(page.getByRole("region", { name: "City Warehouse" })).toBeVisible();
  await expect(page.getByRole("listitem", { name: /Wood, quantity 5/ })).toBeInViewport();
  const footer = page.locator(".city-warehouse-panel .phone-menu-footer");
  const [materialBox, footerBox] = await Promise.all([
    page.getByRole("listitem", { name: /Wood, quantity 5/ }).boundingBox(),
    footer.boundingBox()
  ]);
  expect(materialBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(materialBox!.y + materialBox!.height).toBeLessThanOrEqual(footerBox!.y);
  expect(await overflowMetrics(page, ".city-warehouse-panel")).toEqual({
    documentHorizontal: false,
    elementHorizontal: false
  });
});

test("themed Gold donation validates, fences, and fits both layouts", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<CityWarehouseStory layout="phone" />);
  await page.getByRole("button", { name: "Donate Gold" }).click();
  const dialog = page.getByRole("dialog", { name: "Donate Gold" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("spinbutton", { name: "Whole Gold amount" }).fill("1001");
  await expect(dialog.getByRole("alert")).toContainText("wallet");
  await dialog.getByRole("button", { name: "Max" }).click();
  expect(await overflowMetrics(page, ".city-gold-dialog")).toEqual({
    documentHorizontal: false,
    elementHorizontal: false
  });
  await dialog.getByRole("button", { name: "Donate" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.cityWarehouseActions.filter((action) =>
      action.action === "donate-gold"
    ).length
  )).toBe(1);
});

async function donateFiveWood(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Wood, quantity 20/ }).click();
  await page.getByRole("button", { name: "Donate", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Donate quantity" }).fill("5");
  await page.getByRole("button", { name: "Donate 5" }).click();
  const confirmation = page.getByRole("dialog", { name: "Donate 5 Wood?" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Donate 5" }).click();
}

async function overflowMetrics(
  page: Page,
  selector: string
): Promise<{ documentHorizontal: boolean; elementHorizontal: boolean }> {
  return page.locator(selector).evaluate((element) => ({
    documentHorizontal:
      document.documentElement.scrollWidth > document.documentElement.clientWidth,
    elementHorizontal: element.scrollWidth > element.clientWidth
  }));
}
