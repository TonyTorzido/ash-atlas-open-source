import { expect, test } from "@playwright/experimental-ct-react";

import { PngLabStory } from "./PngLabStory.js";

const visualOutput = process.env.ASH_ATLAS_VISUAL_OUTPUT;

test("desktop lab is spacious, independently scrollable, and enters continuous placement", async ({ page, mount }) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await mount(<PngLabStory />);
  const panel = page.locator(".developer-tools-panel");
  await expect(panel).toHaveAttribute("data-active-tab", "png-lab");
  const browserBox = await page.locator(".developer-png-browser").boundingBox();
  const inspectorBox = await page.locator(".developer-png-inspector").boundingBox();
  expect(browserBox!.x).toBeLessThan(inspectorBox!.x);
  expect(browserBox!.width).toBeGreaterThan(inspectorBox!.width);
  await expect(page.locator(".developer-png-grid > button").first()).toHaveCSS("min-height", "38px");
  const filters = page.locator(".developer-png-filters");
  const grid = page.locator(".developer-png-grid");
  await expect(grid).toHaveCSS("overflow-y", "auto");
  await expect(grid).toHaveCSS("overscroll-behavior-y", "contain");
  const filtersBefore = await filters.boundingBox();
  expect(await grid.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await grid.evaluate((element) => element.scrollBy(0, 700));
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const filtersAfter = await filters.boundingBox();
  expect(filtersAfter!.y).toBe(filtersBefore!.y);
  const addButton = page.getByRole("button", { name: "Add to Screen" });
  await addButton.hover();
  await expect(addButton).toHaveCSS("color", "rgb(28, 20, 8)");
  await addButton.focus();
  await expect(addButton).toBeFocused();
  await page.locator(".developer-png-inspector").evaluate((element) => { element.scrollTop = 0; });
  if (visualOutput) await page.screenshot({ path: `${visualOutput}/png-lab-desktop.png`, fullPage: true });
  await addButton.click();
  await expect(page.getByRole("region", { name: "Local PNG placement map" })).toBeVisible();
  const map = page.getByRole("region", { name: "Local PNG placement map" });
  await map.click({ position: { x: 400, y: 260 } });
  await map.click({ position: { x: 520, y: 350 } });
  await expect(page.locator(".png-story-placement")).toHaveCount(6);
});

test("selected map item gets a persistent inspector with independent sizing", async ({ page, mount }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await mount(<PngLabStory />);
  await page.getByRole("button", { name: "Add to Screen" }).click();
  await page.getByRole("button", { name: /Select Tree story placement/ }).click();
  await expect(page.getByRole("complementary", { name: "Selected PNG instance" })).toBeVisible();
  const slider = page.getByRole("slider", { name: "Selected instance size" });
  await slider.fill("2");
  await expect(page.getByText(/2\.00×/).first()).toBeVisible();
  await page.getByRole("button", { name: "Use This Size for New Copies" }).click();
  if (visualOutput) await page.screenshot({ path: `${visualOutput}/png-lab-map-inspector.png`, fullPage: true });
  await page.getByRole("button", { name: "Open Full PNG Lab" }).click();
  await expect(page.getByRole("slider", { name: "Next placement size" })).toHaveValue("2");
});

test("phone lab stacks cleanly and map inspector becomes a bottom sheet", async ({ page, mount }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<PngLabStory />);
  const browserBox = await page.locator(".developer-png-browser").boundingBox();
  const inspectorBox = await page.locator(".developer-png-inspector").boundingBox();
  expect(browserBox!.y).toBeLessThan(inspectorBox!.y);
  const grid = page.locator(".developer-png-grid");
  await expect(grid).toHaveCSS("overflow-y", "auto");
  await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator(".developer-png-grid > button").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to Screen" })).toBeVisible();
  await page.getByRole("button", { name: "Add to Screen" }).click();
  await page.getByRole("button", { name: /Select Deer story placement/ }).click();
  const sheet = page.getByRole("complementary", { name: "Selected PNG instance" });
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox!.width).toBeGreaterThan(350);
  expect(sheetBox!.y).toBeGreaterThan(200);
  if (visualOutput) await page.screenshot({ path: `${visualOutput}/png-lab-phone.png`, fullPage: true });
});
