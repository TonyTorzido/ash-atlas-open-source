import { mapGroundScaleZoom } from "../map/groundScaleZoom.js";
import type maplibregl from "maplibre-gl";

import type { DevPngAsset } from "./devPngCatalog.js";
import { findRegisteredDevPngAsset } from "./devPngCatalogRegistry.js";
import {
  type DevPngLabController,
  type DevPngPlacement
} from "./devPngLabController.js";
import { calculateDevPngSize } from "./devPngSizing.js";

type RetainedPlacement = {
  placement: DevPngPlacement;
  asset: DevPngAsset;
  element: HTMLButtonElement;
  image: HTMLImageElement;
  missing: HTMLSpanElement;
  loadState: "loading" | "loaded" | "failed";
  cleanup(): void;
};

export type DevPngMapOverlay = {
  render(): void;
  destroy(): void;
};

export function createDevPngMapOverlay(
  map: maplibregl.Map,
  controller: DevPngLabController
): DevPngMapOverlay {
  const canvasContainer = map.getCanvasContainer();
  const document = canvasContainer.ownerDocument;
  const root = document.createElement("div");
  root.className = "dev-png-map-overlay";
  root.setAttribute("aria-label", "Local PNG previews");
  canvasContainer.append(root);
  const retained = new Map<string, RetainedPlacement>();

  const updateVisual = (entry: RetainedPlacement): void => {
    const state = controller.getSnapshot();
    const size = calculateDevPngSize(
      entry.asset,
      state.intrinsicSizes[entry.asset.id] ?? null,
      mapGroundScaleZoom(map),
      entry.placement.scaleMultiplier
    );
    const failed = entry.loadState === "failed";
    const width = size.width ?? 1;
    const height = size.height ?? 1;
    entry.element.style.width = `${width}px`;
    entry.element.style.height = `${height}px`;
    entry.image.style.visibility =
      entry.loadState === "loaded" && size.width !== null && size.height !== null
        ? "visible"
        : "hidden";
    entry.element.style.marginLeft = `${(0.5 - entry.asset.anchor.x) * width}px`;
    entry.element.style.marginTop = `${(0.5 - entry.asset.anchor.y) * height}px`;
    const selected = state.selectedPlacementId === entry.placement.id;
    entry.element.classList.toggle("selected", selected);
    entry.element.setAttribute("aria-pressed", String(selected));
    entry.element.dataset.measurement = failed
      ? "⚠ Image unavailable"
      : size.width === null
      ? "Awaiting intrinsic dimensions"
      : `${Math.round(width * 10) / 10} × ${Math.round(height * 10) / 10} px`;
  };

  const addPlacement = (
    placement: DevPngPlacement,
    asset: DevPngAsset
  ): RetainedPlacement => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "dev-png-map-placement";
    element.setAttribute("aria-label", `Select local ${asset.label} preview`);
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = `${asset.label} local PNG preview`;
    image.draggable = false;
    const missing = document.createElement("span");
    missing.className = "dev-png-map-missing";
    missing.textContent = "⚠";
    missing.title = "PNG failed to load";
    missing.style.width = "28px";
    missing.style.height = "28px";
    element.append(image);
    const onLoad = (): void => {
      entry.loadState = "loaded";
      element.replaceChildren(image);
      element.classList.remove("missing");
      element.removeAttribute("title");
      element.setAttribute("aria-label", `Select local ${asset.label} preview`);
      controller.registerIntrinsicSize(asset.id, image.naturalWidth, image.naturalHeight);
      controller.clearImageFailure(entry.placement.id);
      updateVisual(entry);
    };
    const onError = (): void => {
      entry.loadState = "failed";
      element.replaceChildren(missing);
      element.classList.add("missing");
      element.title = "PNG failed to load";
      element.setAttribute("aria-label", `Select unavailable ${asset.label} PNG preview`);
      controller.reportImageFailure(entry.placement.id, {
        url: asset.url,
        sourcePath: asset.sourcePath,
        message: "PNG failed to load."
      });
      updateVisual(entry);
    };
    let activePointerId: number | null = null;
    let dragged = false;
    const moveToPointer = (event: PointerEvent): void => {
      const bounds = canvasContainer.getBoundingClientRect();
      const location = map.unproject([
        event.clientX - bounds.left,
        event.clientY - bounds.top
      ]);
      controller.movePlacement(entry.placement.id, location.lng, location.lat);
    };
    const onPointerDown = (event: PointerEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      activePointerId = event.pointerId;
      dragged = false;
      controller.selectPlacement(entry.placement.id);
      element.classList.add("dragging");
      element.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (activePointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      dragged = true;
      moveToPointer(event);
    };
    const finishDrag = (event: PointerEvent): void => {
      if (activePointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      if (dragged) moveToPointer(event);
      element.releasePointerCapture?.(event.pointerId);
      activePointerId = null;
      element.classList.remove("dragging");
    };
    const onClick = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      controller.selectPlacement(entry.placement.id);
    };
    const entry: RetainedPlacement = {
      placement,
      asset,
      element,
      image,
      missing,
      loadState: "loading",
      cleanup: () => {
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
        element.removeEventListener("pointerdown", onPointerDown);
        element.removeEventListener("pointermove", onPointerMove);
        element.removeEventListener("pointerup", finishDrag);
        element.removeEventListener("pointercancel", finishDrag);
        element.removeEventListener("click", onClick);
        element.remove();
      }
    };
    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", finishDrag);
    element.addEventListener("pointercancel", finishDrag);
    element.addEventListener("click", onClick);
    root.append(element);
    retained.set(placement.id, entry);
    return entry;
  };

  const render = (): void => {
    const state = controller.getSnapshot();
    const liveIds = new Set(state.placements.map(({ id }) => id));
    for (const [id, entry] of retained) {
      if (liveIds.has(id)) continue;
      entry.cleanup();
      retained.delete(id);
    }
    for (const placement of state.placements) {
      const asset = findRegisteredDevPngAsset(placement.assetId);
      if (!asset) continue;
      const entry = retained.get(placement.id) ?? addPlacement(placement, asset);
      entry.placement = placement;
      entry.asset = asset;
      const point = map.project([placement.longitude, placement.latitude]);
      entry.element.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
      updateVisual(entry);
    }
  };

  const unsubscribe = controller.subscribe(render);
  map.on("render", render);
  render();

  return {
    render,
    destroy: () => {
      unsubscribe();
      map.off("render", render);
      for (const entry of retained.values()) entry.cleanup();
      retained.clear();
      root.remove();
    }
  };
}
