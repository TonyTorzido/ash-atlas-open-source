import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";

import { CityAppPanelStory } from "./CityAppPanelStory.js";

test("City app uses the available desktop width without clipping", async ({ page, mount }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.uiProfile = "desktop"; });
  await mount(<CityAppPanelStory layout="desktop" />);

  const dialog = page.getByRole("dialog", { name: "The Free City of the High Desert Covenant" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".city-app-top-grid").first()).toHaveCSS(
    "grid-template-columns",
    /[0-9.]+px [0-9.]+px/
  );
  await expect(page.locator(".city-app-facility")).toHaveCount(3);
  await expect(page.getByText(/Weaponsmith|Armory/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Build|Upgrade/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open Warehouse" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Buildings" })).toHaveCount(0);
  await expect(page.getByText(/Personal Lodge|Barracks|Demolition Factory|Military Industry|War Camp/i)).toHaveCount(0);

  expect(await overflowMetrics(page, ".city-app-content")).toEqual({
    documentHorizontal: false,
    elementHorizontal: false
  });

});

test("City app stacks, wraps, and scrolls above the phone footer", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.uiProfile = "phone"; });
  await mount(<CityAppPanelStory layout="phone" />);

  const dialog = page.getByRole("dialog", { name: "The Free City of the High Desert Covenant" });
  const body = page.locator(".city-app-panel .phone-destination-body");
  const footer = page.locator(".city-app-panel .phone-menu-footer");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".city-app-top-grid").first()).toHaveCSS("grid-template-columns", /[0-9.]+px/);
  await expect(page.getByText("A Municipality With an Exceptionally Ceremonial Name", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
  const initialFooterBox = await footer.boundingBox();
  expect(initialFooterBox).not.toBeNull();
  expect(initialFooterBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(initialFooterBox?.y ?? 0).toBeGreaterThan(700);
  expect((initialFooterBox?.y ?? 0) + (initialFooterBox?.height ?? 0)).toBeLessThanOrEqual(844);

  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const lastAction = page.getByRole("button", { name: "Destroy City House" });
  await expect(lastAction).toBeVisible();
  const [actionBox, footerBox] = await Promise.all([lastAction.boundingBox(), footer.boundingBox()]);
  expect(actionBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect((actionBox?.y ?? 0) + (actionBox?.height ?? 0)).toBeLessThanOrEqual(footerBox?.y ?? 0);
  expect(await overflowMetrics(page, ".city-app-panel")).toEqual({
    documentHorizontal: false,
    elementHorizontal: false
  });
});

async function overflowMetrics(
  page: Page,
  selector: string
): Promise<{ documentHorizontal: boolean; elementHorizontal: boolean }> {
  return page.locator(selector).evaluate((element) => ({
    documentHorizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    elementHorizontal: element.scrollWidth > element.clientWidth
  }));
}
