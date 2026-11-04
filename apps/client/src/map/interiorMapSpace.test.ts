import {
  INTERIOR_DEFAULT_ZOOM,
  INTERIOR_MAX_ZOOM,
  INTERIOR_MIN_ZOOM,
  INTERIOR_SPATIAL_PROFILES,
  interiorMetersPerUnit,
  interiorPlayerHeightMeters
} from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  enterInteriorSpace,
  enterWorldSpace,
  INTERIOR_BACKGROUND_LAYER_ID,
  clampInteriorCameraCenter,
  interiorCameraBounds,
  interiorFitZoom,
  INTERIOR_FIT_MAX_ZOOM,
  INTERIOR_FIT_MIN_ZOOM,
  isInteriorMapSpace
} from "./interiorMapSpace.js";
import { MAX_MAP_ZOOM } from "./mapZoomConfig.js";
import { SPRITE_BASE_ZOOM, SPRITE_PRESENTATION, spriteHeightForZoom } from "./spritePresentation.js";
import { setWorldPngMasterScalePreview } from "./worldPngMasterScale.js";

beforeEach(() => { setWorldPngMasterScalePreview(1); });
afterEach(() => { setWorldPngMasterScalePreview(null); });

const METERS_PER_DEGREE = 2 * Math.PI * 6_371_008.8 / 360;
/** MapLibre world size: 512px tiles, 360 degrees of longitude. */
function screenPxForMeters(meters: number, zoom: number): number {
  return meters / METERS_PER_DEGREE * 512 * 2 ** zoom / 360;
}

function fakeMap() {
  const layers = [
    { id: "game-map-background" },
    { id: "osm" },
    { id: "world-ocean-fill" },
    { id: "hidden-already" }
  ];
  const visibility = new Map<string, string>([["hidden-already", "none"]]);
  const listeners = new Map<string, () => void>();
  const camera = { center: { lng: 12, lat: 41 }, zoom: 15, bearing: 0, pitch: 0, minZoom: 2, maxZoom: 18 };
  const classes = new Set(["aa-map-globe-space"]);
  const container = {
    classList: {
      remove: (name: string) => { classes.delete(name); },
      toggle: (name: string, force: boolean) => { if (force) classes.add(name); else classes.delete(name); },
      contains: (name: string) => classes.has(name)
    }
  };
  const map = {
    getStyle: () => ({ layers }),
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    addLayer: vi.fn((layer: { id: string }) => { layers.push({ id: layer.id }); }),
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: vi.fn((id: string, _key: string, value: string) => { visibility.set(id, value); }),
    setPaintProperty: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener); }),
    off: vi.fn((event: string) => { listeners.delete(event); }),
    getCenter: () => camera.center,
    getZoom: () => camera.zoom,
    getBearing: () => camera.bearing,
    getPitch: () => camera.pitch,
    getMinZoom: () => camera.minZoom,
    getMaxZoom: () => camera.maxZoom,
    setMinZoom: vi.fn((zoom: number) => { camera.minZoom = zoom; }),
    setMaxZoom: vi.fn((zoom: number) => { camera.maxZoom = zoom; }),
    setMaxBounds: vi.fn(),
    easeTo: vi.fn((options: { center: [number, number] }) => {
      camera.center = { lng: options.center[0], lat: options.center[1] };
    }),
    jumpTo: vi.fn((options: { center: [number, number]; zoom: number }) => {
      camera.center = { lng: options.center[0], lat: options.center[1] };
      camera.zoom = options.zoom;
    }),
    stop: vi.fn(),
    getContainer: () => container
  };
  return { map: map as typeof map & maplibregl.Map, layers, visibility, listeners, camera, container };
}

const frame = {
  spaceKey: "dungeon:one:room_a",
  roomWidth: 1000,
  roomHeight: 800,
  metersPerUnit: interiorMetersPerUnit(INTERIOR_SPATIAL_PROFILES.dungeon),
  focus: { x: 500, y: 700 }
};

describe("interior map space", () => {
  it("starts at the zoom where the world player sprite covers the interior player height", () => {
    for (const profile of Object.values(INTERIOR_SPATIAL_PROFILES)) {
      const spritePx = spriteHeightForZoom(INTERIOR_DEFAULT_ZOOM, SPRITE_BASE_ZOOM, SPRITE_PRESENTATION.player);
      const playerPx = screenPxForMeters(interiorPlayerHeightMeters(profile), INTERIOR_DEFAULT_ZOOM);
      expect(Math.abs(spritePx / playerPx - 1)).toBeLessThan(0.02);
    }
    expect(INTERIOR_MAX_ZOOM).toBeGreaterThan(INTERIOR_DEFAULT_ZOOM);
    expect(INTERIOR_MAX_ZOOM - MAX_MAP_ZOOM).toBeLessThanOrEqual(1);
    // A 1000-unit dungeon room fits a 360px-wide phone at the minimum zoom.
    const roomPx = screenPxForMeters(1000 * frame.metersPerUnit, INTERIOR_MIN_ZOOM);
    expect(roomPx).toBeLessThanOrEqual(360);
  });

  it("clamps the camera to the room plus a margin with local +y to the south", () => {
    const [[west, south], [east, north]] = interiorCameraBounds(frame, 0);
    expect(west).toBeCloseTo(0, 12);
    expect(north).toBeCloseTo(0, 12);
    expect(east).toBeGreaterThan(0);
    expect(south).toBeLessThan(0);
  });

  it("rubber-bands an off-room centre back on moveend without touching zoom", () => {
    const { map, listeners, camera } = fakeMap();
    enterInteriorSpace(map, frame);
    const zoom = camera.zoom;
    camera.center = { lng: 5, lat: 5 };
    listeners.get("moveend")?.();
    expect(map.easeTo).toHaveBeenCalledTimes(1);
    expect(camera.center.lng).toBeCloseTo(interiorCameraBounds(frame)[1][0], 12);
    expect(camera.center.lat).toBeCloseTo(interiorCameraBounds(frame)[1][1], 12);
    expect(camera.zoom).toBe(zoom);
    listeners.get("moveend")?.();
    expect(map.easeTo).toHaveBeenCalledTimes(1);
  });

  it("hides world layers, jumps to the room, and restores the world camera on exit", () => {
    const { map, visibility, listeners, camera, container } = fakeMap();
    const saved = enterInteriorSpace(map, frame);
    expect(isInteriorMapSpace(map)).toBe(true);
    expect(saved).toMatchObject({ center: { lat: 41, lon: 12 }, zoom: 15, minZoom: 2, maxZoom: 18 });
    expect(visibility.get("osm")).toBe("none");
    expect(visibility.get("world-ocean-fill")).toBe("none");
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: INTERIOR_BACKGROUND_LAYER_ID,
      type: "background"
    }));
    expect(container.classList.contains("aa-map-globe-space")).toBe(false);
    expect(camera.zoom).toBe(INTERIOR_DEFAULT_ZOOM);
    expect(camera.minZoom).toBe(INTERIOR_MIN_ZOOM);
    expect(camera.maxZoom).toBe(INTERIOR_MAX_ZOOM);
    expect(camera.center.lat).toBeLessThan(0);
    // No hard maxBounds: it blocks zoom-out and breaks cursor-anchored zoom.
    expect(map.setMaxBounds).toHaveBeenLastCalledWith(null);
    expect(listeners.has("moveend")).toBe(true);

    // World code showing a layer while indoors is recorded and re-hidden.
    visibility.set("world-ocean-fill", "visible");
    listeners.get("styledata")?.();
    expect(visibility.get("world-ocean-fill")).toBe("none");

    // The same space only refreshes the clamp; it never re-centres the camera.
    camera.zoom = 16;
    enterInteriorSpace(map, frame);
    expect(camera.zoom).toBe(16);

    expect(enterWorldSpace(map)).toBe(saved);
    expect(isInteriorMapSpace(map)).toBe(false);
    expect(camera).toMatchObject({ center: { lat: 41, lng: 12 }, zoom: 15, minZoom: 2, maxZoom: 18 });
    expect(map.setMaxBounds).toHaveBeenLastCalledWith(null);
    expect(visibility.get("osm")).toBe("visible");
    expect(visibility.get("world-ocean-fill")).toBe("visible");
    expect(visibility.get("hidden-already")).toBe("none");
    expect(visibility.get(INTERIOR_BACKGROUND_LAYER_ID)).toBe("none");
    expect(listeners.has("styledata")).toBe(false);
    expect(enterWorldSpace(map)).toBeNull();
  });

  it("fits the room on every world entry and keeps the zoom between rooms", () => {
    const { map, camera, listeners, layers, container } = fakeMap();
    Object.assign(container, { clientWidth: 1280, clientHeight: 720 });
    enterInteriorSpace(map, frame);
    const fitted = camera.zoom;
    expect(fitted).toBe(interiorFitZoom(frame, { widthPx: 1280, heightPx: 720 }));
    expect(fitted).toBeLessThan(INTERIOR_DEFAULT_ZOOM - 0.5);
    camera.zoom = 17.2;
    enterInteriorSpace(map, { ...frame, spaceKey: "dungeon:one:room_b", focus: { x: 100, y: 100 } });
    expect(camera.zoom).toBe(17.2);
    enterWorldSpace(map);
    // The saved world camera comes back, and the next entry fits again.
    expect(camera.zoom).toBe(15);
    enterInteriorSpace(map, { ...frame, spaceKey: "dungeon:two:room_a" });
    expect(camera.zoom).toBe(fitted);
    // The interior background is added again when the style was not ready.
    layers.splice(layers.findIndex((layer) => layer.id === INTERIOR_BACKGROUND_LAYER_ID), 1);
    listeners.get("styledata")?.();
    expect(layers.some((layer) => layer.id === INTERIOR_BACKGROUND_LAYER_ID)).toBe(true);
  });

  it("fit zoom is padded, capped for legibility, and falls back without a viewport", () => {
    expect(interiorFitZoom(frame, null)).toBe(INTERIOR_DEFAULT_ZOOM);
    const huge = { ...frame, roomWidth: 100_000, roomHeight: 100_000 };
    expect(interiorFitZoom(huge, { widthPx: 1280, heightPx: 720 })).toBe(INTERIOR_FIT_MIN_ZOOM);
    const tiny = { ...frame, roomWidth: 20, roomHeight: 20 };
    expect(interiorFitZoom(tiny, { widthPx: 1280, heightPx: 720 })).toBe(INTERIOR_FIT_MAX_ZOOM);
    const mid = { ...frame, roomWidth: 300, roomHeight: 240 };
    const z = interiorFitZoom(mid, { widthPx: 1280, heightPx: 720 });
    expect(z).toBeGreaterThan(INTERIOR_FIT_MIN_ZOOM);
    expect(z).toBeLessThan(INTERIOR_FIT_MAX_ZOOM);
    const roomWidthPx = screenPxForMeters(mid.roomWidth * mid.metersPerUnit, z);
    const roomHeightPx = screenPxForMeters(mid.roomHeight * mid.metersPerUnit, z);
    expect(roomWidthPx).toBeLessThanOrEqual(1280 * 0.8 + 1);
    expect(roomHeightPx).toBeLessThanOrEqual(720 * 0.8 + 1);
  });

  it("pans freely over the room: no snap to the middle, a centre past an edge stops at that edge", () => {
    const zoom = 18.35;
    const [[west, south], [east, north]] = interiorCameraBounds(frame, 0);
    for (const view of [{ widthPx: 600, heightPx: 400, zoom }, { widthPx: 1_000_000, heightPx: 400, zoom }]) {
      // A side pan inside the room stays where the player left it, even when the room is smaller than the view.
      const side = { lat: (south + north) / 2, lon: west + (east - west) * 0.1 };
      expect(clampInteriorCameraCenter(frame, side, view)).toEqual(side);
      // Past a corner: pulled back to the room's edge, not its middle.
      const past = clampInteriorCameraCenter(frame, { lat: south - 1, lon: east + 1 }, view);
      expect(past.lon).toBeCloseTo(east, 12);
      expect(past.lat).toBeCloseTo(south, 12);
    }
  });

  it.each([
    ["Chieftain's Throne (1400x1400) on a 1460x900 desktop", 1400, 1400, 1460, 900],
    ["Cistern Warrens Hatch Landing (1000x1000) on a 1460x900 desktop", 1000, 1000, 1460, 900],
    ["Hatch Landing on a 390x844 phone", 1000, 1000, 390, 844],
    ["Throne on a 390x844 phone", 1400, 1400, 390, 844]
  ])("leaves wheel and pinch zoom room both ways in %s", (_name, roomWidth, roomHeight, widthPx, heightPx) => {
    const { map, camera, container, listeners } = fakeMap();
    Object.assign(container, { clientWidth: widthPx, clientHeight: heightPx });
    const room = { ...frame, roomWidth, roomHeight, focus: { x: roomWidth / 2, y: roomHeight / 2 } };
    enterInteriorSpace(map, room);
    // The zoom range is the interior range, never collapsed, and no maxBounds fights the zoom anchor.
    expect(camera.minZoom).toBe(INTERIOR_MIN_ZOOM);
    expect(camera.maxZoom).toBe(INTERIOR_MAX_ZOOM);
    expect(map.setMaxBounds).toHaveBeenCalledTimes(1);
    expect(map.setMaxBounds).toHaveBeenCalledWith(null);
    // The opening fit is strictly inside the range: the player can zoom in and out.
    expect(camera.zoom).toBeGreaterThan(camera.minZoom);
    expect(camera.zoom).toBeLessThan(camera.maxZoom);
    // A finished wheel/pinch gesture at either end of the range keeps its zoom through the moveend clamp.
    for (const zoom of [INTERIOR_MIN_ZOOM, INTERIOR_DEFAULT_ZOOM, INTERIOR_MAX_ZOOM]) {
      camera.zoom = zoom;
      camera.center = { lng: camera.center.lng + 0.002, lat: camera.center.lat - 0.002 };
      listeners.get("moveend")?.();
      expect(camera.zoom).toBe(zoom);
    }
  });

  it("does not ease-loop at the minimum zoom, so a later wheel or pinch step is never swallowed", () => {
    const { map, camera, container, listeners } = fakeMap();
    Object.assign(container, { clientWidth: 1464, clientHeight: 1300 });
    const room = { ...frame, roomWidth: 1000, roomHeight: 1000, focus: { x: 500, y: 500 } };
    enterInteriorSpace(map, room);
    // Fully zoomed out the room is smaller than the view, so every moveend wants it centred.
    camera.zoom = INTERIOR_MIN_ZOOM;
    camera.center = { lng: camera.center.lng + 0.01, lat: camera.center.lat - 0.01 };
    // An ease lands within float noise of its target but never exactly on it (as MapLibre does).
    (map.easeTo as ReturnType<typeof vi.fn>).mockImplementation((options: { center: [number, number] }) => {
      camera.center = { lng: options.center[0] + 3e-11, lat: options.center[1] - 3e-11 };
    });
    const before = (map.easeTo as ReturnType<typeof vi.fn>).mock.calls.length;
    for (let i = 0; i < 25; i += 1) listeners.get("moveend")?.();
    // One rubber-band to the centre, then it settles: no endless re-ease.
    expect((map.easeTo as ReturnType<typeof vi.fn>).mock.calls.length - before).toBe(1);
    // Zoom is untouched and a following zoom-in step goes through the same settled path.
    expect(camera.zoom).toBe(INTERIOR_MIN_ZOOM);
    camera.zoom = INTERIOR_MIN_ZOOM + 0.5;
    listeners.get("moveend")?.();
    expect((map.easeTo as ReturnType<typeof vi.fn>).mock.calls.length - before).toBeLessThanOrEqual(2);
    expect(camera.zoom).toBe(INTERIOR_MIN_ZOOM + 0.5);
  });
});
