// @vitest-environment jsdom
import type maplibregl from "maplibre-gl";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DevPngLabController } from "./devPngLabController.js";
import { DEV_PNG_ASSETS } from "./devPngCatalog.js";
import { createDevPngMapOverlay } from "./devPngMapOverlay.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("local PNG map overlay", () => {
  it("geographically projects local placements and selects only its visible element", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const renderHandlers = new Set<() => void>();
    const map = {
      getCanvasContainer: () => container,
      getZoom: () => 14,
      getCenter: () => ({ lat: 0 }),
      project: ([longitude, latitude]: [number, number]) => ({
        x: longitude + 200,
        y: latitude + 100
      }),
      unproject: ([x, y]: [number, number]) => ({ lng: x - 200, lat: y - 100 }),
      on: (type: string, handler: () => void) => {
        if (type === "render") renderHandlers.add(handler);
      },
      off: (type: string, handler: () => void) => {
        if (type === "render") renderHandlers.delete(handler);
      }
    } as unknown as maplibregl.Map;
    const controller = new DevPngLabController();
    const overlay = createDevPngMapOverlay(map, controller);
    const placement = controller.place(-106, 35)!;
    const button = container.querySelector<HTMLButtonElement>(".dev-png-map-placement");

    expect(button?.style.transform).toContain("94px, 135px");
    expect(button?.querySelectorAll("img")).toHaveLength(1);
    expect(button?.querySelector(".dev-png-map-missing")).toBeNull();
    button?.click();
    expect(controller.getSnapshot().selectedPlacementId).toBe(placement.id);
    expect(button?.classList.contains("selected")).toBe(true);
    expect(container.querySelector(".dev-png-map-overlay")).toBeTruthy();

    overlay.destroy();
    expect(container.querySelector(".dev-png-map-overlay")).toBeNull();
    expect(renderHandlers.size).toBe(0);
  });

  it("drags a placement to the pointer location and keeps it selected", () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 620,
      width: 800, height: 600, toJSON: () => ({})
    });
    document.body.append(container);
    const map = {
      getCanvasContainer: () => container,
      getZoom: () => 14,
      getCenter: () => ({ lat: 0 }),
      project: () => ({ x: 100, y: 100 }),
      unproject: ([x, y]: [number, number]) => ({ lng: x / 10, lat: y / 10 }),
      on: () => undefined,
      off: () => undefined
    } as unknown as maplibregl.Map;
    const controller = new DevPngLabController();
    const overlay = createDevPngMapOverlay(map, controller);
    const placement = controller.place(-106, 35)!;
    const button = container.querySelector<HTMLButtonElement>(".dev-png-map-placement")!;

    button.dispatchEvent(pointerEvent("pointerdown", 1, 110, 120));
    button.dispatchEvent(pointerEvent("pointermove", 1, 310, 420));
    button.dispatchEvent(pointerEvent("pointerup", 1, 310, 420));

    expect(controller.getSnapshot().placements[0]).toMatchObject({
      id: placement.id,
      longitude: 30,
      latitude: 40
    });
    expect(controller.getSnapshot().selectedPlacementId).toBe(placement.id);
    expect(button.classList.contains("dragging")).toBe(false);
    overlay.destroy();
  });

  it("uses a compact diagnostic marker when a PNG fails to load", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const map = {
      getCanvasContainer: () => container,
      getZoom: () => 14,
      getCenter: () => ({ lat: 0 }),
      project: () => ({ x: 100, y: 100 }),
      unproject: () => ({ lng: -106, lat: 35 }),
      on: () => undefined,
      off: () => undefined
    } as unknown as maplibregl.Map;
    const controller = new DevPngLabController();
    const overlay = createDevPngMapOverlay(map, controller);
    controller.place(-106, 35);
    const button = container.querySelector<HTMLButtonElement>(".dev-png-map-placement")!;
    button.querySelector("img")!.dispatchEvent(new Event("error"));
    const marker = button.querySelector<HTMLElement>(".dev-png-map-missing")!;

    expect(button.classList.contains("missing")).toBe(true);
    expect(marker.textContent).toBe("⚠");
    expect(marker.style.width).toBe("28px");
    expect(marker.style.height).toBe("28px");
    expect(button.dataset.measurement).toBe("⚠ Image unavailable");
    expect(button.textContent).not.toContain("Missing PNG");
    expect(button.querySelector("img")).toBeNull();
    expect(controller.getSnapshot().imageFailures[controller.getSnapshot().placements[0]!.id])
      .toMatchObject({ sourcePath: expect.stringMatching(/\.png$/i) });
    button.click();
    expect(controller.getSnapshot().selectedPlacementId).not.toBeNull();
    controller.deleteSelected();
    expect(container.querySelector(".dev-png-map-placement")).toBeNull();
    overlay.destroy();
  });

  it("shows only the loaded PNG and removes a prior failure marker immediately", () => {
    const { container, controller, overlay } = setupOverlay();
    const placement = controller.place(-106, 35)!;
    const button = container.querySelector<HTMLButtonElement>(".dev-png-map-placement")!;
    const image = button.querySelector<HTMLImageElement>("img")!;

    image.dispatchEvent(new Event("error"));
    expect(button.querySelector(".dev-png-map-missing")).toBeTruthy();
    setNaturalSize(image, 160, 240);
    image.dispatchEvent(new Event("load"));

    expect(button.querySelector("img")).toBe(image);
    expect(button.querySelector(".dev-png-map-missing")).toBeNull();
    expect(button.classList.contains("missing")).toBe(false);
    expect(button.textContent).not.toContain("Missing PNG");
    expect(controller.getSnapshot().imageFailures[placement.id]).toBeUndefined();
    overlay.destroy();
  });

  it("never reveals a fallback while resizing a valid PNG", () => {
    const { container, controller, overlay } = setupOverlay();
    controller.place(-106, 35);
    const button = container.querySelector<HTMLButtonElement>(".dev-png-map-placement")!;
    const image = button.querySelector<HTMLImageElement>("img")!;
    setNaturalSize(image, 100, 200);
    image.dispatchEvent(new Event("load"));
    const initialWidth = button.style.width;

    controller.setSelectedMultiplier(4);

    expect(button.style.width).not.toBe(initialWidth);
    expect(button.querySelector("img")).toBe(image);
    expect(button.querySelector(".dev-png-map-missing")).toBeNull();
    overlay.destroy();
  });

  it("keeps the failed marker fixed-size while the intended hit area resizes", () => {
    const { container, controller, overlay } = setupOverlay();
    const asset = DEV_PNG_ASSETS.find(({ productionSize, placeable }) =>
      placeable && productionSize?.kind === "fixed"
    )!;
    controller.selectAsset(asset.id);
    controller.place(-106, 35);
    const button = container.querySelector<HTMLButtonElement>(".dev-png-map-placement")!;
    button.querySelector("img")!.dispatchEvent(new Event("error"));
    const marker = button.querySelector<HTMLElement>(".dev-png-map-missing")!;
    const initialHitWidth = button.style.width;

    controller.setSelectedMultiplier(5);

    expect(button.style.width).not.toBe(initialHitWidth);
    expect(marker.style.width).toBe("28px");
    expect(marker.style.height).toBe("28px");
    expect(button.querySelectorAll("img, .dev-png-map-missing")).toHaveLength(1);
    overlay.destroy();
  });

  it("keeps the ordinary hit area visually transparent", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    expect(css).toMatch(
      /\.dev-png-map-placement\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s
    );
  });
});

function setupOverlay(): {
  container: HTMLDivElement;
  controller: DevPngLabController;
  overlay: ReturnType<typeof createDevPngMapOverlay>;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const map = {
    getCanvasContainer: () => container,
    getZoom: () => 14,
    getCenter: () => ({ lat: 0 }),
    project: () => ({ x: 100, y: 100 }),
    unproject: () => ({ lng: -106, lat: 35 }),
    on: () => undefined,
    off: () => undefined
  } as unknown as maplibregl.Map;
  const controller = new DevPngLabController();
  return {
    container,
    controller,
    overlay: createDevPngMapOverlay(map, controller)
  };
}

function setNaturalSize(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
}

function pointerEvent(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number
): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event as unknown as PointerEvent;
}
