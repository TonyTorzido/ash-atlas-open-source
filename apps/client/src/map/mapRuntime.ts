import type {
  GameplayAreaMovementAuthority,
  LatLon,
  ResolvedGameplayAreaTarget
} from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import type { ClientConfig } from "../config.js";
import { bindMapMovementInput } from "../movement/mapMovementInput.js";
import { createMap, type MapZoomOptions } from "./createMap.js";
import { subscribeWorldOverlayRelease } from "./worldOverlays.js";

export interface MapRuntimeHandlers {
  onLoad(): void;
  onBaseMapPainted(): void;
  onWorldRelease(releaseId: string): void;
  onZoom(): void;
  onZoomStart(event: maplibregl.MapLibreEvent): void;
  onZoomEnd(): void;
  onRender(): void;
  onIdle(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onMoveStart(event: maplibregl.MapLibreEvent): void;
  onMoveEnd(): void;
  onResize(): void;
  onContextMenu(event: maplibregl.MapMouseEvent): void;
  onPendingClick(event: maplibregl.MapMouseEvent): void;
  onPendingClickEnd(
    event: maplibregl.MapMouseEvent,
    outcome: "confirmed" | "cancelled"
  ): void;
  handleClickImmediately?(event: maplibregl.MapMouseEvent): boolean;
  clicksSwing?(event: maplibregl.MapMouseEvent): boolean;
  onClick(event: maplibregl.MapMouseEvent): void;
  getGameplayArea(): GameplayAreaMovementAuthority | null;
  usePrecisionLongPressOutside?(): boolean;
  onMove(intent: ResolvedGameplayAreaTarget): void;
  onLongPressStart(intent: ResolvedGameplayAreaTarget): void;
  onLongPressMove(intent: ResolvedGameplayAreaTarget): void;
  onLongPressRelease(intent: ResolvedGameplayAreaTarget): void;
  onLongPressCancel(): void;
}

export interface GameMapRuntime {
  readonly map: maplibregl.Map;
  attach(handlers: MapRuntimeHandlers): void;
  invalidateBaseMapPaint(): void;
  cancelPendingInteraction(): void;
  destroy(beforeMapRemove?: () => void): void;
}

export interface AttachedMapRuntime {
  invalidateBaseMapPaint(): void;
  cancelPendingInteraction(): void;
  detach(): void;
}

export function createGameMapRuntime(
  container: HTMLElement,
  config: ClientConfig,
  zoomOptions?: MapZoomOptions,
  initialCenter?: LatLon
): GameMapRuntime {
  const map = createMap(container, config, zoomOptions, initialCenter);
  let attachment: AttachedMapRuntime | null = null;
  let destroyed = false;

  return {
    map,
    attach(handlers): void {
      if (destroyed || attachment) throw new Error("Map runtime may only be attached once.");
      attachment = attachMapRuntime(map, handlers);
    },
    invalidateBaseMapPaint(): void {
      attachment?.invalidateBaseMapPaint();
      map.triggerRepaint();
    },
    cancelPendingInteraction(): void {
      attachment?.cancelPendingInteraction();
    },
    destroy(beforeMapRemove): void {
      if (destroyed) return;
      destroyed = true;
      attachment?.detach();
      attachment = null;
      beforeMapRemove?.();
      map.remove();
    }
  };
}

export function attachMapRuntime(
  map: maplibregl.Map,
  handlers: MapRuntimeHandlers
): AttachedMapRuntime {
  let unsubscribeWorldOverlayRelease = (): void => undefined;
  const subscribeToWorldRelease = (): void => {
    unsubscribeWorldOverlayRelease();
    unsubscribeWorldOverlayRelease = subscribeWorldOverlayRelease(map, handlers.onWorldRelease);
  };
  const firstLoad = (): void => handlers.onLoad();
  let baseMapPainted = false;
  const render = (): void => {
    handlers.onRender();
    if (baseMapPainted || !map.isSourceLoaded("osm")) return;
    baseMapPainted = true;
    handlers.onBaseMapPainted();
  };

  map.on("load", subscribeToWorldRelease);
  void map.once("load", firstLoad);
  map.on("zoom", handlers.onZoom);
  map.on("zoomstart", handlers.onZoomStart);
  map.on("zoomend", handlers.onZoomEnd);
  map.on("render", render);
  map.on("idle", handlers.onIdle);
  map.dragPan.enable();
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.on("dragstart", handlers.onDragStart);
  map.on("dragend", handlers.onDragEnd);
  map.on("movestart", handlers.onMoveStart);
  map.on("moveend", handlers.onMoveEnd);
  map.on("resize", handlers.onResize);
  map.on("contextmenu", handlers.onContextMenu);
  const movementInput = bindMapMovementInput(map, {
    getGameplayArea: handlers.getGameplayArea,
    ...(handlers.usePrecisionLongPressOutside
      ? { usePrecisionLongPressOutside: handlers.usePrecisionLongPressOutside }
      : {}),
    onMove: handlers.onMove,
    onLongPressStart: handlers.onLongPressStart,
    onLongPressMove: handlers.onLongPressMove,
    onLongPressRelease: handlers.onLongPressRelease,
    onLongPressCancel: handlers.onLongPressCancel,
    onPendingClick: handlers.onPendingClick,
    onPendingClickEnd: handlers.onPendingClickEnd,
    ...(handlers.clicksSwing ? { clicksSwing: handlers.clicksSwing } : {}),
    ...(handlers.handleClickImmediately
      ? { handleClickImmediately: handlers.handleClickImmediately }
      : {}),
    onClick: handlers.onClick
  });

  return {
    invalidateBaseMapPaint: () => {
      baseMapPainted = false;
    },
    cancelPendingInteraction: movementInput.cancelPendingInteraction,
    detach: () => {
      map.off("load", subscribeToWorldRelease);
      map.off("load", firstLoad);
      map.off("zoom", handlers.onZoom);
      map.off("zoomstart", handlers.onZoomStart);
      map.off("zoomend", handlers.onZoomEnd);
      map.off("render", render);
      map.off("idle", handlers.onIdle);
      map.off("dragstart", handlers.onDragStart);
      map.off("dragend", handlers.onDragEnd);
      map.off("movestart", handlers.onMoveStart);
      map.off("moveend", handlers.onMoveEnd);
      map.off("resize", handlers.onResize);
      map.off("contextmenu", handlers.onContextMenu);
      movementInput.destroy();
      unsubscribeWorldOverlayRelease();
    }
  };
}
