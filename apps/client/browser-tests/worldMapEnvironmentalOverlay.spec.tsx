import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { WorldMapEnvironmentalOverlayStory } from "./WorldMapEnvironmentalOverlayStory.js";

async function expectMarkerProjected(marker: Locator): Promise<void> {
  await expect(marker).toBeVisible();
  await expect.poll(async () => marker.evaluate((element: HTMLElement) => {
    const imageRect = element.querySelector("img")?.getBoundingClientRect();
    const mapRect = document.querySelector(".world-map-canvas")?.getBoundingClientRect();
    const translations = [...element.style.transform.matchAll(
      /translate\(([-\d.]+)px, ([-\d.]+)px\)/g
    )];
    const projectedTranslation = translations.at(-1);
    if (!imageRect || !mapRect || !projectedTranslation) return null;
    const style = getComputedStyle(element);
    return {
      position: style.position,
      transformTransition: style.transitionProperty.split(",").map((value) =>
        value.trim()
      ).includes("transform"),
      alignedX: Math.abs(
        imageRect.x + imageRect.width / 2 -
          (mapRect.x + Number(projectedTranslation[1]))
      ) <= 1,
      alignedY: Math.abs(
        imageRect.y + imageRect.height / 2 -
          (mapRect.y + Number(projectedTranslation[2]))
      ) <= 1
    };
  }).catch(() => null)).toEqual({
    position: "absolute",
    transformTransition: false,
    alignedX: true,
    alignedY: true
  });
}

test("desktop World Map overlays load after the base map and switch without World API traffic", async ({ mount, page }) => {
  const worldRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) worldRequests.push(request.url());
  });
  await mount(<WorldMapEnvironmentalOverlayStory layout="desktop" />);
  await expect(page.getByRole("region", { name: "Map" })).toBeVisible();
  const desktopCanvas = await page.locator(".world-map-canvas").boundingBox();
  expect(desktopCanvas!.height).toBeGreaterThan(500);
  const headerBox = await page.locator(".game-app-header").boundingBox();
  const mapRegionBox = await page.locator(".world-map-desktop-map-region").boundingBox();
  expect(mapRegionBox!.y).toBeCloseTo(headerBox!.y + headerBox!.height, 0);
  const closeAlignment = await page.locator(".destination-shell-close").evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const glyphRect = button.querySelector("span")!.getBoundingClientRect();
    return {
      x: Math.abs(buttonRect.x + buttonRect.width / 2 - (glyphRect.x + glyphRect.width / 2)),
      y: Math.abs(buttonRect.y + buttonRect.height / 2 - (glyphRect.y + glyphRect.height / 2))
    };
  });
  expect(closeAlignment.x).toBeLessThanOrEqual(1);
  expect(closeAlignment.y).toBeLessThanOrEqual(1.5);
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close Layers", exact: true })).toBeVisible();
  await expect(page.getByText(/Broad travel guidance only/)).toHaveCount(0);
  await page.getByRole("tab", { name: "Biomes", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Tundra", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "Tundra", exact: true }).uncheck();
  await expect(page.getByRole("checkbox", { name: "Frozen Waste", exact: true })).toBeChecked();
  await page.getByRole("tab", { name: "Elevation", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Alpine", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Tundra", exact: true })).toHaveCount(0);
  expect(worldRequests).toEqual([]);
});

test("desktop World Map QoL renders styled player at center and starts one step below max zoom", async ({ mount, page }) => {
  const appearanceRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("hair2-ce98952e")) appearanceRequests.push(request.url());
  });

  await mount(<WorldMapEnvironmentalOverlayStory layout="desktop" />);
  const playerCanvas = page.locator(".world-map-player-marker-canvas");
  await expect(playerCanvas).toBeVisible();
  await expect.poll(() => appearanceRequests.length).toBeGreaterThan(0);

  await expect.poll(async () => {
    const markerBox = await page.locator(".world-map-player-marker").boundingBox();
    const mapBox = await page.locator(".maplibregl-canvas").boundingBox();
    if (!markerBox || !mapBox) return null;
    return Math.max(
      Math.abs(
        markerBox.x + markerBox.width / 2 - (mapBox.x + mapBox.width / 2)
      ),
      Math.abs(
        markerBox.y + markerBox.height - (mapBox.y + mapBox.height / 2)
      )
    );
  }).toBeLessThanOrEqual(3);

  const zoomIn = page.locator(".maplibregl-ctrl-zoom-in");
  await expect(zoomIn).toBeEnabled();
  await zoomIn.click();
  await expect(zoomIn).toBeDisabled();
});

test("desktop map controls clear the canonical header under the phone-profile desktop preview", async ({ mount, page }) => {
  await mount(<WorldMapEnvironmentalOverlayStory layout="desktop" uiProfile="phone" />);
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  const headerBox = await page.locator(".game-app-header").boundingBox();
  const panelBox = await page.getByRole("region", { name: "Layers", exact: true }).boundingBox();
  expect(panelBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height + 7);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
  test(`phone World Map keeps a compact Layers popover over a usable map at ${viewport.width}x${viewport.height}`, async ({ mount, page }) => {
    await page.setViewportSize(viewport);
    await mount(<WorldMapEnvironmentalOverlayStory layout="phone" />);
    await expect(page.getByText("Atlas Ledger", { exact: true })).toBeVisible();
    const mapRegionBox = await page.locator(".world-map-phone-map-region").boundingBox();
    const headerBox = await page.locator(".phone-menu-header").boundingBox();
    const footerBox = await page.locator(".phone-menu-footer").boundingBox();
    expect(mapRegionBox!.height).toBeGreaterThan(viewport.height * 0.65);
    expect(headerBox!.height).toBeGreaterThanOrEqual(64);
    await expect(page.locator(".world-map-destination-tray")).toHaveCount(0);
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(viewport.height);
    const kingdomTriggerBox = await page.getByRole("button", { name: "Show Kingdom on map", exact: true }).boundingBox();
    const manorTriggerBox = await page.getByRole("button", { name: "Show Manor on map", exact: true }).boundingBox();
    const layersTriggerBox = await page.getByRole("button", { name: "Layers", exact: true }).boundingBox();
    const developerTriggerBox = await page.getByRole("button", { name: "DEV", exact: true }).boundingBox();
    expect(kingdomTriggerBox!.width).toBe(44);
    expect(manorTriggerBox!.width).toBe(44);
    expect(layersTriggerBox!.width).toBe(44);
    expect(kingdomTriggerBox!.x).toBeLessThan(manorTriggerBox!.x);
    expect(manorTriggerBox!.x).toBeLessThan(layersTriggerBox!.x);
    expect(developerTriggerBox!.y).toBeGreaterThan(mapRegionBox!.y + mapRegionBox!.height - 60);
    const destinationMarker = page.locator('button.world-map-marker[aria-label="London"]');
    const markerBoxBefore = await destinationMarker.boundingBox();
    await page.getByRole("button", { name: "Layers", exact: true }).click();
    const popover = page.getByRole("region", { name: "Layers", exact: true });
    await expect(popover).toBeVisible();
    await expect(page.locator(".world-map-layer-backdrop")).toHaveCount(0);
    const popoverBox = await popover.boundingBox();
    expect(popoverBox!.width).toBeLessThanOrEqual(224);
    expect(popoverBox!.height).toBeLessThanOrEqual(300);
    expect(mapRegionBox!.x + mapRegionBox!.width - (popoverBox!.x + popoverBox!.width)).toBeLessThanOrEqual(8);
    expect(popoverBox!.y - mapRegionBox!.y).toBeLessThanOrEqual(8);
    await page.getByRole("tab", { name: "Biomes", exact: true }).click();
    const scrollArea = page.locator(".world-map-layer-scroll");
    expect(await scrollArea.evaluate((element) => getComputedStyle(element).overscrollBehavior)).toBe("contain");
    await scrollArea.hover();
    await page.mouse.wheel(0, 500);
    const markerBoxAfter = await destinationMarker.boundingBox();
    expect(markerBoxAfter!.x).toBeCloseTo(markerBoxBefore!.x, 0);
    expect(markerBoxAfter!.y).toBeCloseTo(markerBoxBefore!.y, 0);
    await expect(page.getByRole("checkbox", { name: "Tundra", exact: true })).toBeChecked();
    await page.getByRole("checkbox", { name: "Tundra", exact: true }).uncheck();
    await expect(page.getByRole("checkbox", { name: "Frozen Waste", exact: true })).toBeChecked();
    const canvasBox = await page.locator(".maplibregl-canvas").boundingBox();
    const panX = canvasBox!.x + canvasBox!.width - 30;
    const panY = canvasBox!.y + canvasBox!.height / 2;
    await page.mouse.move(panX, panY);
    await page.mouse.wheel(0, -500);
    await page.mouse.down();
    await page.mouse.move(panX - 70, panY, { steps: 5 });
    await page.mouse.up();
    const markerBoxAfterPan = await destinationMarker.boundingBox();
    expect(markerBoxAfterPan === null || Math.abs(markerBoxAfterPan.x - markerBoxBefore!.x) > 20)
      .toBe(true);
    await page.getByRole("button", { name: "Close Layers", exact: true }).click();
    await expect(popover).toHaveCount(0);
    await expect(page.locator(".phone-menu-footer")).toBeVisible();
  });
}

test("phone World Map releases and recreates its map across open-close-open", async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const component = await mount(<WorldMapEnvironmentalOverlayStory layout="phone" />);
    await expect(page.getByRole("region", { name: "Map" })).toBeVisible();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await component.unmount();
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
  }
});

for (const layout of ["desktop", "phone"] as const) {
  test(`${layout} destination PNG remains centered on its coordinate across zoom`, async ({ mount, page }) => {
    await page.setViewportSize(layout === "phone"
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 });
    await mount(<WorldMapEnvironmentalOverlayStory layout={layout} fixture="baker" />);
    const marker = page.locator('button.world-map-marker[aria-label="Baker"]');
    await expect(marker).toBeVisible();

    await expect(marker).toHaveClass(/maplibregl-marker-anchor-center/);
    await expect(marker).toHaveAttribute("data-label-visible", "false");
    await expectMarkerProjected(marker);

    const zoomIn = page.locator(".maplibregl-ctrl-zoom-in");
    for (let step = 0; step < 2; step += 1) {
      await zoomIn.evaluate((button: HTMLButtonElement) => button.click());
      await page.waitForTimeout(400);
    }
    await expect(marker).toHaveAttribute("data-label-visible", "true");
    await expectMarkerProjected(marker);
    await marker.click();
    await expect(marker).toHaveClass(/selected/);
    await expectMarkerProjected(marker);

    const zoomOut = page.locator(".maplibregl-ctrl-zoom-out");
    for (let step = 0; step < 3; step += 1) {
      await zoomOut.evaluate((button: HTMLButtonElement) => button.click());
      await page.waitForTimeout(400);
    }
    await expect(marker).toHaveAttribute("data-label-visible", "false");
    await expectMarkerProjected(marker);
  });
}

for (const layout of ["desktop", "phone"] as const) {
  test(`${layout} keeps city, manor, Kingdom, and shrine markers on their projected coordinates`, async ({ mount, page }) => {
    await page.setViewportSize(layout === "phone"
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 });
    await mount(<WorldMapEnvironmentalOverlayStory layout={layout} fixture="destination-kinds" />);

    for (const name of ["Baker", "Plains Manor", "Lake Kingdom", "Eastern Shrine"]) {
      const marker = page.getByRole("button", { name, exact: true });
      await expectMarkerProjected(marker);
    }
  });

  test(`${layout} preserves Baker through a cluster split and merge`, async ({ mount, page }) => {
    await page.setViewportSize(layout === "phone"
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 });
    await mount(<WorldMapEnvironmentalOverlayStory layout={layout} fixture="cluster-transition" />);
    const group = page.locator("button.world-map-marker--group");
    await expect(group).toBeVisible();

    const zoomIn = page.locator(".maplibregl-ctrl-zoom-in");
    for (let step = 0; step < 2; step += 1) {
      await zoomIn.evaluate((button: HTMLButtonElement) => button.click());
      await page.waitForTimeout(400);
    }
    const baker = page.getByRole("button", { name: "Baker", exact: true });
    const nearBaker = page.getByRole("button", { name: "Near Baker", exact: true });
    await expect(baker).toBeVisible();
    await expect(nearBaker).toBeVisible();
    for (const marker of [baker, nearBaker]) {
      await expectMarkerProjected(marker);
    }

    const zoomOut = page.locator(".maplibregl-ctrl-zoom-out");
    for (let step = 0; step < 2; step += 1) {
      await zoomOut.evaluate((button: HTMLButtonElement) => button.click());
      await page.waitForTimeout(400);
    }
    await expect(group).toBeVisible();
  });
}
