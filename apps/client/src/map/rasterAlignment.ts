/**
 * Raster pixel alignment (docs/plans/raster-smooth.md).
 *
 * MapLibre 5.24 draws raster tiles with `align = !painter.options.moving` (draw_raster.ts, `drawTiles`). When aligned, the tile matrix
 * is rounded to whole CSS pixels (MercatorTransform `_alignedProjMatrix`). The follow camera moves with zero-duration pans/jumps, which
 * finish synchronously and clear `map._moving` before the render, so every followed frame is "not moving" and the OSM raster steps in
 * whole pixels while the character moves smoothly. A finger drag stays "moving" and is unaligned, which is why it is smooth.
 *
 * The fix wraps `painter.render` and overrides `options.moving` for that frame only. `map.isMoving()` itself is never changed.
 *
 * Modes (localStorage `ash-atlas:raster-alignment`, Developer tools):
 * - "auto" (default): unaligned whenever MapLibre says moving, the camera changed within SETTLE_MS, or the zoom is fractional (the game
 *   almost never sits on an integer zoom, where alignment buys no crispness). Aligned only for a settled camera at an integer zoom.
 * - "off": never aligned. "on": stock MapLibre behaviour.
 */
import maplibregl from "maplibre-gl";

export type RasterAlignmentMode = "auto" | "on" | "off";

const KEY = "ash-atlas:raster-alignment";
/** A camera change this recent keeps the raster unaligned, so there is no pixel snap right after motion stops. */
export const RASTER_SETTLE_MS = 250;
const INTEGER_ZOOM_EPS = 1e-3;

export type RasterAlignmentContext = {
  /** MapLibre's own `isMoving()` at render time. */
  moving: boolean;
  zoom: number;
  /** ms since the camera transform last changed. */
  sinceCameraChangeMs: number;
};

export function parseRasterAlignmentMode(raw: string | null | undefined): RasterAlignmentMode {
  return raw === "on" || raw === "off" ? raw : "auto";
}

/** The `moving` value handed to the painter for one frame: true means the raster is drawn unaligned. */
export function rasterPainterMoving(mode: RasterAlignmentMode, ctx: RasterAlignmentContext): boolean {
  if (mode === "on") return ctx.moving;
  if (mode === "off") return true;
  if (ctx.moving) return true;
  if (ctx.sinceCameraChangeMs < RASTER_SETTLE_MS) return true;
  return Math.abs(ctx.zoom - Math.round(ctx.zoom)) > INTEGER_ZOOM_EPS;
}

function read(): string | null {
  try { return window.localStorage.getItem(KEY); } catch { return null; }
}

let mode: RasterAlignmentMode = typeof window === "undefined" ? "auto" : parseRasterAlignmentMode(read());
const listeners = new Set<() => void>();

export function rasterAlignmentMode(): RasterAlignmentMode { return mode; }

export function setRasterAlignmentMode(next: RasterAlignmentMode): void {
  mode = next;
  try {
    if (next === "auto") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, next);
  } catch { /* storage unavailable: the switch holds for this session only */ }
  for (const listener of listeners) listener();
}

export function subscribeRasterAlignmentMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const stats = { renders: 0, maplibreMoving: 0, aligned: 0, unaligned: 0 };
let installState: "none" | "installed" | "unsupported" = "none";
let lastRenderMoving: boolean | null = null;
let lastRenderAligned: boolean | null = null;

export function resetRasterAlignmentStats(): void {
  stats.renders = 0; stats.maplibreMoving = 0; stats.aligned = 0; stats.unaligned = 0;
}

/** Telemetry for motionReport: what the renderer actually did, not what the JS camera did. */
export function rasterAlignmentReport(map: { getMinZoom?(): number; getMaxZoom?(): number } | null): Record<string, string | number | boolean | null> {
  const r2 = (n: number | undefined): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  return {
    maplibreVersion: safeVersion(),
    rasterAlignMode: mode,
    rasterAlignPatch: installState,
    rasterRenders: stats.renders,
    rasterMaplibreMovingRenders: stats.maplibreMoving,
    rasterAlignedRenders: stats.aligned,
    rasterUnalignedRenders: stats.unaligned,
    rasterLastRenderMoving: lastRenderMoving,
    rasterLastRenderAligned: lastRenderAligned,
    cameraMinZoom: r2(map?.getMinZoom?.()),
    cameraMaxZoom: r2(map?.getMaxZoom?.())
  };
}

function safeVersion(): string | null {
  try { return maplibregl.getVersion(); } catch { return null; }
}

type PainterLike = { render?: (style: unknown, options: { moving?: boolean }) => unknown; __rasterAlignPatched?: boolean };

/** Version-pinned: only MapLibre 5.x, whose painter takes `render(style, options)` with `options.moving`. Anything else is left stock. */
export function installRasterAlignment(map: maplibregl.Map): void {
  const painter = (map as unknown as { painter?: PainterLike }).painter;
  const version = safeVersion();
  const original = painter?.render;
  if (!painter || typeof original !== "function" || !version || !version.startsWith("5.")) {
    installState = "unsupported";
    return;
  }
  if (painter.__rasterAlignPatched) return;
  painter.__rasterAlignPatched = true;
  let lastKey = "";
  let lastChangeMs = -Infinity;
  painter.render = function patchedRender(this: unknown, style: unknown, options: { moving?: boolean }): unknown {
    const now = performance.now();
    const c = map.getCenter();
    const zoom = map.getZoom();
    const key = `${c.lng}|${c.lat}|${zoom}|${map.getBearing()}|${map.getPitch()}`;
    if (key !== lastKey) { lastKey = key; lastChangeMs = now; }
    const maplibreMoving = !!options?.moving;
    const moving = rasterPainterMoving(mode, { moving: maplibreMoving, zoom, sinceCameraChangeMs: now - lastChangeMs });
    stats.renders += 1;
    if (maplibreMoving) stats.maplibreMoving += 1;
    if (moving) stats.unaligned += 1; else stats.aligned += 1;
    lastRenderMoving = maplibreMoving;
    lastRenderAligned = !moving;
    return original.call(this, style, options ? { ...options, moving } : options);
  };
  installState = "installed";
}

if (typeof window !== "undefined") {
  // Test and support hook, like __ASH_ATLAS_CAMERA_MODES__.
  (window as unknown as { __ASH_ATLAS_RASTER_ALIGNMENT__?: unknown }).__ASH_ATLAS_RASTER_ALIGNMENT__ = {
    get mode() { return mode; },
    set mode(next: RasterAlignmentMode) { setRasterAlignmentMode(parseRasterAlignmentMode(next)); },
    report: () => rasterAlignmentReport(null)
  };
}
