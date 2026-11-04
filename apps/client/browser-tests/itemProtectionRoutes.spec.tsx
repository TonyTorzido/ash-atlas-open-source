import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";

import { ItemProtectionRoutesStory } from "./ItemProtectionRoutesStory.js";

test.use({
  hasTouch: true,
  viewport: { width: 390, height: 844 }
});

test("phone Inventory keeps status, filters, and actions visible without horizontal scrolling", async ({
  page,
  mount
}) => {
  await mount(<ItemProtectionRoutesStory />);
  const actionBar = page.locator(".inventory-carry-header");
  await expect.poll(() => actionBar.evaluate(
    (element) => element.scrollWidth <= element.clientWidth
  )).toBe(true);
  await expect(page.getByLabel("Inventory weight")).toBeInViewport();
  for (const name of ["All", "Equipment", "Resources", "Consumables"]) await expect(page.getByRole("tab", { name, exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Item Protection", exact: true })).toBeInViewport();
});

test("phone quantity editing stays alive from Inventory", async ({
  page,
  mount
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.itemProtectionSaves = [];
  });
  await mount(<ItemProtectionRoutesStory />);

  await page.getByRole("button", { name: "Item Protection" }).click();
  await editAndSaveLeather(page, "100");
  await expect.poll(() => page.evaluate(() => window.itemProtectionSaves)).toEqual([{
    itemId: "leather",
    variant: "tanned",
    quantity: 100,
    revision: 7
  }]);

  expect(pageErrors).toEqual([]);
});

async function editAndSaveLeather(
  page: Page,
  value: string
): Promise<void> {
  const input = page.getByRole("textbox", {
    name: "Keep Leather in Inventory"
  });
  await input.tap();
  await input.fill(value);
  await expect(input).toHaveValue(value);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog", { name: "Item Protection" })).toBeVisible();
  await expect(input).toHaveValue(value);
}

test("desktop uses themed quantity and equipment controls with keyboard operation", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(<ItemProtectionRoutesStory layout="desktop" />);
  await page.getByRole("button", { name: "Item Protection" }).click();
  const dialog = page.getByRole("dialog", { name: "Item Protection" });
  const input = dialog.getByRole("textbox", { name: "Keep Leather in Inventory" });
  await expect(dialog.locator('input[type="number"], input[type="checkbox"]')).toHaveCount(0);
  await input.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("3");
  const protect = dialog.getByRole("button", { name: "Protect", exact: true });
  await protect.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Protected", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(dialog.getByRole("button", { name: "System Locked" })).toBeDisabled();
  await expect(dialog).toContainText("Equipped items cannot be stored");
  await input.fill("-1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("nonnegative whole number");
});

test("phone controls keep 44px targets and stay inside the narrow viewport", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<ItemProtectionRoutesStory />);
  await page.getByRole("button", { name: "Item Protection" }).click();
  const dialog = page.getByRole("dialog", { name: "Item Protection" });
  for (const name of [
    "Decrease protected Leather",
    "Increase protected Leather",
    "Save",
    "Protect"
  ]) {
    const box = await dialog.getByRole("button", { name, exact: true }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
