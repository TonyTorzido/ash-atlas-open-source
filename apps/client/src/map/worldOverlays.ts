import type maplibregl from "maplibre-gl";

import {
  WATER_VISUAL_TILES_ARTIFACT_SHA256,
  WATER_VISUAL_TILES_LAKE_PERIMETER_LAYER,
  WATER_VISUAL_TILES_LAKE_SURFACE_LAYER,
  WATER_VISUAL_TILES_MANIFEST_SHA256,
  WATER_VISUAL_TILES_MAX_ZOOM,
  WATER_VISUAL_TILES_MIN_ZOOM,
  WATER_VISUAL_TILES_OCEAN_COASTLINE_LAYER,
  WATER_VISUAL_TILES_OCEAN_SURFACE_LAYER,
  WATER_VISUAL_TILES_POLICY,
  WATER_VISUAL_TILES_RELEASE_ID,
  WATER_VISUAL_TILES_RIVER_PERIMETER_LAYER,
  WATER_VISUAL_TILES_RIVER_SURFACE_LAYER,
  waterVisualTilesSourceUrl
} from "./waterVisualTiles.js";
import { GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM } from "./mapZoomConfig.js";
import { WORLD_EDGE_FOG_LAYER_ID } from "./worldEdgeFog.js";

export const WORLD_OVERLAY_SOURCE_ID = "world-overlays";
export const WORLD_WATER_VISUAL_SOURCE_ID = "world-water-visual-tiles";
export const WORLD_OCEAN_FILL_LAYER_ID = "world-ocean-fill";
export const WORLD_OCEAN_COAST_FILL_LAYER_ID = "world-ocean-coast-fill";
export const WORLD_OCEAN_PERIMETER_LAYER_ID = "world-ocean-perimeter";
export const WORLD_FRESHWATER_FILL_LAYER_ID = "world-freshwater-fill";
export const WORLD_FRESHWATER_OUTLINE_LAYER_ID = "world-freshwater-outline";
export const WORLD_RIVER_FILL_LAYER_ID = "world-river-fill";
export const WORLD_RIVER_OUTLINE_LAYER_ID = "world-river-outline";
export const WORLD_ADMINISTRATIVE_LAYER_ID = "world-administrative-line";
export const WORLD_OVERLAY_DIAGNOSTICS_ID = "ash-atlas-world-overlay-diagnostics";

export const OCEAN_FILL_COLOR = "#78b6d6";
export const OCEAN_OUTLINE_COLOR = "#2f6f98";
export const LAKE_FILL_COLOR = "#b8e6b8";
export const LAKE_OUTLINE_COLOR = "#3a8f5a";
export const RIVER_FILL_COLOR = "#c7eaf5";
export const RIVER_OUTLINE_COLOR = "#78bdd2";
export const OCEAN_NORMAL_FILL_OPACITY = 0.25;
export const OCEAN_PLACEMENT_FILL_OPACITY = 0.25;
export const FRESHWATER_NORMAL_FILL_OPACITY = 0.15;
export const FRESHWATER_PLACEMENT_FILL_OPACITY = 0.15;
export const RIVER_NORMAL_FILL_OPACITY = 0.25;
export const RIVER_PLACEMENT_FILL_OPACITY = 0.25;
export const WATER_NORMAL_OUTLINE_WIDTH = 1.25;
export const WATER_PLACEMENT_OUTLINE_WIDTH = 1.8;
export const WATER_NORMAL_OUTLINE_OPACITY = 1;
export const WATER_PLACEMENT_OUTLINE_OPACITY = 1;

const REQUEST_DEBOUNCE_MS = 180;
const MAX_CACHE_ENTRIES = 8;
const OVERLAY_BBOX_DECIMALS = 6;
const GLOBAL_OVERLAY_REQUEST_KEY = `global:${GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM}`;
const OCEAN_FILTER: maplibregl.FilterSpecification = [
  "all",
  ["==", ["get", "kind"], "water-no-build"],
  ["==", ["get", "water_kind"], "ocean"]
];
const OCEAN_COASTLINE_FILTER: maplibregl.FilterSpecification = [
  "==",
  ["get", "kind"],
  "water-coastline"
];
const GAMEPLAY_LAYER_ANCHORS = [
  WORLD_EDGE_FOG_LAYER_ID,
  "kingdom-territory-fill",
  "kingdom-objects"
] as const;

type OverlayCapabilities = {
  flagPlacementWater?: boolean;
  waterNoBuildOverlay?: boolean;
  unionedWaterSurface?: boolean;
};

type OverlayFeatureCollection = {
  type: "FeatureCollection";
  features: unknown[];
  metadata?: {
    release?: { releaseId?: string; release_id?: string };
    runtime?: { branch?: string; sha?: string } | null;
    capabilities?: OverlayCapabilities;
    zoom?: number;
    diagnostics?: Record<string, unknown>;
  };
};

type OverlayViewport = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type OverlayCacheEntry = {
  data: OverlayFeatureCollection;
  viewport: OverlayViewport;
  // Output of removeAdministrativeViewportEdges, kept so a cache hit skips the main-thread walk.
  rendered?: OverlayFeatureCollection;
};

type OverlayRequestOutcome =
  | "idle"
  | "loading"
  | "success"
  | "http-error"
  | "schema-error"
  | "network-error";

const presenters = new WeakMap<maplibregl.Map, WorldOverlayPresenter>();
const desiredPlacementModes = new WeakMap<maplibregl.Map, boolean>();

export function installWorldOverlays(map: maplibregl.Map, worldApiBase: string): WorldOverlayPresenter {
  const existing = presenters.get(map);
  if (existing) return existing;
  const presenter = new WorldOverlayPresenter(map, worldApiBase);
  presenter.setPlacementMode(desiredPlacementModes.get(map) ?? false);
  presenters.set(map, presenter);
  void map.once("remove", () => {
    presenter.destroy();
    presenters.delete(map);
    desiredPlacementModes.delete(map);
  });
  return presenter;
}

export function setWaterOverlayPlacementMode(map: maplibregl.Map | null, active: boolean): void {
  if (!map) return;
  desiredPlacementModes.set(map, active);
  presenters.get(map)?.setPlacementMode(active);
}

export function subscribeWorldOverlayRelease(
  map: maplibregl.Map,
  listener: (releaseId: string) => void
): () => void {
  return presenters.get(map)?.subscribeRelease(listener) ?? (() => undefined);
}

export class WorldOverlayPresenter {
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private lastRequestKey: string | null = null;
  private placementMode = false;
  private releaseId: string | null = null;
  private sourceFeatureCount = 0;
  private waterFeatureCount = 0;
  private featureKinds: string[] = [];
  private runtimeIdentity: { branch?: string; sha?: string } | null = null;
  private capabilities: OverlayCapabilities | null = null;
  private serverDiagnostics: Record<string, unknown> | null = null;
  private requestOutcome: OverlayRequestOutcome = "idle";
  private requestUrl: string | null = null;
  private responseStatus: number | null = null;
  private requestError: string | null = null;
  private installing = false;
  private currentData: OverlayFeatureCollection = emptyFeatureCollection();
  private readonly releaseListeners = new Set<(releaseId: string) => void>();
  private readonly cache = new Map<string, OverlayCacheEntry>();

  constructor(
    private readonly map: maplibregl.Map,
    private readonly worldApiBase: string
  ) {
    this.ensureInstalled();
    this.map.on("styledata", this.handleStyleLifecycle);
    this.map.on("moveend", this.scheduleRefresh);
    this.map.on("zoomend", this.scheduleRefresh);
    void this.refresh();
  }

  setPlacementMode(active: boolean): void {
    if (this.placementMode === active) return;
    this.placementMode = active;
    this.applyWaterStyle();
  }

  subscribeRelease(listener: (releaseId: string) => void): () => void {
    this.releaseListeners.add(listener);
    if (this.releaseId) listener(this.releaseId);
    return () => this.releaseListeners.delete(listener);
  }

  async refresh(): Promise<void> {
    if (this.map.getZoom() <= GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM) {
      if (this.lastRequestKey === GLOBAL_OVERLAY_REQUEST_KEY) return;
      this.lastRequestKey = GLOBAL_OVERLAY_REQUEST_KEY;
      this.generation += 1;
      this.controller?.abort();
      this.controller = null;
      this.clearData();
      return;
    }
    const request = overlayRequest(this.map, this.worldApiBase);
    if (request.key === this.lastRequestKey) return;
    this.lastRequestKey = request.key;
    this.requestUrl = request.url.toString();
    const cached = this.cache.get(request.key);
    if (cached) {
      this.requestOutcome = "success";
      this.responseStatus = 200;
      this.requestError = null;
      this.setData(cached.data, cached.viewport, cached);
      return;
    }

    const requestGeneration = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    this.requestOutcome = "loading";
    this.responseStatus = null;
    this.requestError = null;
    this.publishDevelopmentDiagnostics();
    try {
      const response = await fetch(request.url, { signal: this.controller.signal });
      if (requestGeneration !== this.generation) return;
      if (!response.ok) {
        this.recordFailure(
          "http-error",
          `HTTP ${response.status} for ${request.url.toString()}`,
          response.status
        );
        console.warn(`Global world overlay request failed: HTTP ${response.status} ${request.url.toString()}`);
        return;
      }
      const data: unknown = await response.json();
      if (requestGeneration !== this.generation) return;
      if (!isOverlayFeatureCollection(data)) {
        this.recordFailure(
          "schema-error",
          `Invalid GeoJSON FeatureCollection from ${request.url.toString()}`,
          response.status
        );
        console.warn(`Global world overlay response was invalid: ${request.url.toString()}`);
        return;
      }
      this.requestOutcome = "success";
      this.responseStatus = response.status;
      this.requestError = null;
      this.remember(request.key, data, request.viewport);
      this.setData(data, request.viewport, this.cache.get(request.key));
    } catch (error) {
      if (!isAbortError(error) && requestGeneration === this.generation) {
        const message = error instanceof Error ? error.message : String(error);
        this.recordFailure("network-error", `${message} (${request.url.toString()})`, null);
        console.warn(`Global world overlay request failed: ${request.url.toString()}`, error);
      }
    }
  }

  destroy(): void {
    this.map.off("moveend", this.scheduleRefresh);
    this.map.off("zoomend", this.scheduleRefresh);
    this.map.off("styledata", this.handleStyleLifecycle);
    this.controller?.abort();
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    if (import.meta.env.DEV && typeof document !== "undefined") {
      document.getElementById(WORLD_OVERLAY_DIAGNOSTICS_ID)?.remove();
    }
  }

  private readonly handleStyleLifecycle = (): void => {
    this.ensureInstalled();
  };

  private ensureInstalled(): void {
    if (this.installing || !this.map.isStyleLoaded()) return;
    this.installing = true;
    try {
      if (!this.map.getSource(WORLD_OVERLAY_SOURCE_ID)) {
        this.map.addSource(WORLD_OVERLAY_SOURCE_ID, {
          type: "geojson",
          data: this.currentData as Parameters<maplibregl.GeoJSONSource["setData"]>[0]
        });
      }
      if (!this.map.getSource(WORLD_WATER_VISUAL_SOURCE_ID)) {
        this.map.addSource(WORLD_WATER_VISUAL_SOURCE_ID, {
          type: "vector",
          url: waterVisualTilesSourceUrl(this.worldApiBase)
        });
      }
      const beforeLayer = GAMEPLAY_LAYER_ANCHORS.find((id) => Boolean(this.map.getLayer(id)));
      const layers: maplibregl.LayerSpecification[] = [{
        id: WORLD_OCEAN_FILL_LAYER_ID,
        type: "fill",
        source: WORLD_OVERLAY_SOURCE_ID,
        filter: OCEAN_FILTER,
        minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
        paint: {
          "fill-color": OCEAN_FILL_COLOR,
          "fill-antialias": false,
          "fill-opacity": OCEAN_NORMAL_FILL_OPACITY
        }
      }, {
        id: WORLD_OCEAN_COAST_FILL_LAYER_ID,
        type: "fill",
        source: WORLD_WATER_VISUAL_SOURCE_ID,
        "source-layer": WATER_VISUAL_TILES_OCEAN_SURFACE_LAYER,
        minzoom: WATER_VISUAL_TILES_MIN_ZOOM,
        maxzoom: 24,
        paint: {
          "fill-color": OCEAN_FILL_COLOR,
          "fill-antialias": false,
          "fill-opacity": OCEAN_NORMAL_FILL_OPACITY
        }
      }, {
        id: WORLD_OCEAN_PERIMETER_LAYER_ID,
        type: "line",
        source: WORLD_OVERLAY_SOURCE_ID,
        filter: OCEAN_COASTLINE_FILTER,
        minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
        paint: {
          "line-color": OCEAN_OUTLINE_COLOR,
          "line-width": WATER_NORMAL_OUTLINE_WIDTH,
          "line-opacity": WATER_NORMAL_OUTLINE_OPACITY
        }
      }, {
        id: WORLD_FRESHWATER_FILL_LAYER_ID,
        type: "fill",
        source: WORLD_WATER_VISUAL_SOURCE_ID,
        "source-layer": WATER_VISUAL_TILES_LAKE_SURFACE_LAYER,
        minzoom: WATER_VISUAL_TILES_MIN_ZOOM,
        maxzoom: 24,
        paint: {
          "fill-color": LAKE_FILL_COLOR,
          "fill-antialias": false,
          "fill-opacity": FRESHWATER_NORMAL_FILL_OPACITY
        }
      }, {
        id: WORLD_FRESHWATER_OUTLINE_LAYER_ID,
        type: "line",
        source: WORLD_WATER_VISUAL_SOURCE_ID,
        "source-layer": WATER_VISUAL_TILES_LAKE_PERIMETER_LAYER,
        minzoom: WATER_VISUAL_TILES_MIN_ZOOM,
        maxzoom: 24,
        paint: {
          "line-color": LAKE_OUTLINE_COLOR,
          "line-width": WATER_NORMAL_OUTLINE_WIDTH,
          "line-opacity": WATER_NORMAL_OUTLINE_OPACITY
        }
      }, {
        id: WORLD_RIVER_FILL_LAYER_ID,
        type: "fill",
        source: WORLD_WATER_VISUAL_SOURCE_ID,
        "source-layer": WATER_VISUAL_TILES_RIVER_SURFACE_LAYER,
        minzoom: WATER_VISUAL_TILES_MIN_ZOOM,
        maxzoom: 24,
        paint: {
          "fill-color": RIVER_FILL_COLOR,
          "fill-antialias": false,
          "fill-opacity": RIVER_NORMAL_FILL_OPACITY
        }
      }, {
        id: WORLD_RIVER_OUTLINE_LAYER_ID,
        type: "line",
        source: WORLD_WATER_VISUAL_SOURCE_ID,
        "source-layer": WATER_VISUAL_TILES_RIVER_PERIMETER_LAYER,
        minzoom: WATER_VISUAL_TILES_MIN_ZOOM,
        maxzoom: 24,
        paint: {
          "line-color": RIVER_OUTLINE_COLOR,
          "line-width": WATER_NORMAL_OUTLINE_WIDTH,
          "line-opacity": WATER_NORMAL_OUTLINE_OPACITY
        }
      }, {
        id: WORLD_ADMINISTRATIVE_LAYER_ID,
        type: "line",
        source: WORLD_OVERLAY_SOURCE_ID,
        filter: ["==", ["get", "kind"], "administrative"],
        minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
        paint: {
          "line-color": "#8a8175",
          "line-width": ["match", ["get", "level"], "country", 1.8, "region", 1.3, 1],
          "line-opacity": 0.5,
          "line-dasharray": [2, 2]
        }
      }];
      for (const layer of layers) {
        if (!this.map.getLayer(layer.id)) this.map.addLayer(layer, beforeLayer);
      }
      this.applyWaterStyle();
    } finally {
      this.installing = false;
    }
  }

  private readonly scheduleRefresh = (): void => {
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, REQUEST_DEBOUNCE_MS);
  };

  private applyWaterStyle(): void {
    this.map.setPaintProperty(
      WORLD_OCEAN_FILL_LAYER_ID,
      "fill-opacity",
      this.placementMode ? OCEAN_PLACEMENT_FILL_OPACITY : OCEAN_NORMAL_FILL_OPACITY
    );
    this.map.setPaintProperty(
      WORLD_OCEAN_COAST_FILL_LAYER_ID,
      "fill-opacity",
      this.placementMode ? OCEAN_PLACEMENT_FILL_OPACITY : OCEAN_NORMAL_FILL_OPACITY
    );
    this.map.setPaintProperty(
      WORLD_FRESHWATER_FILL_LAYER_ID,
      "fill-opacity",
      this.placementMode
        ? FRESHWATER_PLACEMENT_FILL_OPACITY
        : FRESHWATER_NORMAL_FILL_OPACITY
    );
    this.map.setPaintProperty(
      WORLD_RIVER_FILL_LAYER_ID,
      "fill-opacity",
      this.placementMode
        ? RIVER_PLACEMENT_FILL_OPACITY
        : RIVER_NORMAL_FILL_OPACITY
    );
    for (const layerId of [
      WORLD_OCEAN_PERIMETER_LAYER_ID,
      WORLD_FRESHWATER_OUTLINE_LAYER_ID,
      WORLD_RIVER_OUTLINE_LAYER_ID
    ]) {
      this.map.setPaintProperty(
        layerId,
        "line-width",
        this.placementMode ? WATER_PLACEMENT_OUTLINE_WIDTH : WATER_NORMAL_OUTLINE_WIDTH
      );
      this.map.setPaintProperty(
        layerId,
        "line-opacity",
        this.placementMode ? WATER_PLACEMENT_OUTLINE_OPACITY : WATER_NORMAL_OUTLINE_OPACITY
      );
    }
    this.publishDevelopmentDiagnostics();
  }

  private setData(
    data: OverlayFeatureCollection,
    viewport: OverlayViewport,
    cacheEntry?: OverlayCacheEntry
  ): void {
    const renderData =
      cacheEntry?.rendered ?? removeAdministrativeViewportEdges(data, viewport);
    if (cacheEntry) cacheEntry.rendered = renderData;
    this.currentData = renderData;
    this.ensureInstalled();
    (this.map.getSource(WORLD_OVERLAY_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
      renderData as Parameters<maplibregl.GeoJSONSource["setData"]>[0]
    );
    this.sourceFeatureCount = data.features.length;
    this.featureKinds = [...new Set(data.features.map(overlayFeatureKind).filter(isString))].sort();
    this.waterFeatureCount = data.features.filter(
      (feature) => overlayFeatureKind(feature) === "water-no-build"
    ).length;
    this.runtimeIdentity = data.metadata?.runtime ?? null;
    this.capabilities = data.metadata?.capabilities ?? null;
    this.serverDiagnostics = data.metadata?.diagnostics ?? null;
    const releaseId = data.metadata?.release?.releaseId ?? data.metadata?.release?.release_id;
    if (releaseId && releaseId !== this.releaseId) {
      this.releaseId = releaseId;
      for (const listener of this.releaseListeners) listener(releaseId);
    }
    this.publishDevelopmentDiagnostics();
  }

  private clearData(): void {
    this.currentData = emptyFeatureCollection();
    this.sourceFeatureCount = 0;
    this.waterFeatureCount = 0;
    this.featureKinds = [];
    this.runtimeIdentity = null;
    this.capabilities = null;
    this.serverDiagnostics = null;
    this.requestOutcome = "idle";
    this.requestUrl = null;
    this.responseStatus = null;
    this.requestError = null;
    this.ensureInstalled();
    (this.map.getSource(WORLD_OVERLAY_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
      this.currentData as Parameters<maplibregl.GeoJSONSource["setData"]>[0]
    );
    this.publishDevelopmentDiagnostics();
  }

  private publishDevelopmentDiagnostics(): void {
    if (!import.meta.env.DEV || typeof document === "undefined") return;
    let output = document.getElementById(WORLD_OVERLAY_DIAGNOSTICS_ID);
    if (!output) {
      output = document.createElement("output");
      output.id = WORLD_OVERLAY_DIAGNOSTICS_ID;
      output.hidden = true;
      output.setAttribute("aria-hidden", "true");
      document.body.append(output);
    }
    const waterLayerIds = [
      WORLD_OCEAN_FILL_LAYER_ID,
      WORLD_OCEAN_COAST_FILL_LAYER_ID,
      WORLD_OCEAN_PERIMETER_LAYER_ID,
      WORLD_FRESHWATER_FILL_LAYER_ID,
      WORLD_FRESHWATER_OUTLINE_LAYER_ID,
      WORLD_RIVER_FILL_LAYER_ID,
      WORLD_RIVER_OUTLINE_LAYER_ID
    ];
    const fillLayerIds = new Set([
      WORLD_OCEAN_FILL_LAYER_ID,
      WORLD_OCEAN_COAST_FILL_LAYER_ID,
      WORLD_FRESHWATER_FILL_LAYER_ID,
      WORLD_RIVER_FILL_LAYER_ID
    ]);
    output.textContent = JSON.stringify({
      sourceId: WORLD_OVERLAY_SOURCE_ID,
      sourcePresent: Boolean(this.map.getSource(WORLD_OVERLAY_SOURCE_ID)),
      sourceFeatureCount: this.sourceFeatureCount,
      waterFeatureCount: this.waterFeatureCount,
      featureKinds: this.featureKinds,
      placementMode: this.placementMode,
      releaseId: this.releaseId,
      runtime: this.runtimeIdentity,
      capabilities: this.capabilities,
      serverDiagnostics: this.serverDiagnostics,
      waterVisualTiles: {
        sourceId: WORLD_WATER_VISUAL_SOURCE_ID,
        sourcePresent: Boolean(this.map.getSource(WORLD_WATER_VISUAL_SOURCE_ID)),
        releaseId: WATER_VISUAL_TILES_RELEASE_ID,
        policy: WATER_VISUAL_TILES_POLICY,
        manifestSha256: WATER_VISUAL_TILES_MANIFEST_SHA256,
        artifactSha256: WATER_VISUAL_TILES_ARTIFACT_SHA256,
        oceanSurfaceLayer: WATER_VISUAL_TILES_OCEAN_SURFACE_LAYER,
        oceanCoastlineLayer: WATER_VISUAL_TILES_OCEAN_COASTLINE_LAYER,
        lakeSurfaceLayer: WATER_VISUAL_TILES_LAKE_SURFACE_LAYER,
        lakePerimeterLayer: WATER_VISUAL_TILES_LAKE_PERIMETER_LAYER,
        riverSurfaceLayer: WATER_VISUAL_TILES_RIVER_SURFACE_LAYER,
        riverPerimeterLayer: WATER_VISUAL_TILES_RIVER_PERIMETER_LAYER,
        minZoom: WATER_VISUAL_TILES_MIN_ZOOM,
        maxZoom: WATER_VISUAL_TILES_MAX_ZOOM
      },
      request: {
        outcome: this.requestOutcome,
        url: this.requestUrl,
        httpStatus: this.responseStatus,
        error: this.requestError
      },
      layers: waterLayerIds.map((id) => ({
        id,
        present: Boolean(this.map.getLayer(id)),
        filter: this.map.getFilter(id),
        visibility: this.map.getLayoutProperty(id, "visibility") ?? "visible",
        fillOpacity: fillLayerIds.has(id)
          ? this.map.getPaintProperty(id, "fill-opacity")
          : undefined,
        lineWidth: !fillLayerIds.has(id)
          ? this.map.getPaintProperty(id, "line-width")
          : undefined,
        lineOpacity: !fillLayerIds.has(id)
          ? this.map.getPaintProperty(id, "line-opacity")
          : undefined
      })),
      styleOrder: this.map.getStyle().layers.map((layer) => layer.id)
    });
  }

  private remember(
    key: string,
    data: OverlayFeatureCollection,
    viewport: OverlayViewport
  ): void {
    this.cache.delete(key);
    this.cache.set(key, { data, viewport: { ...viewport } });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private recordFailure(
    outcome: Exclude<OverlayRequestOutcome, "idle" | "loading" | "success">,
    message: string,
    status: number | null
  ): void {
    this.requestOutcome = outcome;
    this.responseStatus = status;
    this.requestError = message;
    this.lastRequestKey = null;
    this.publishDevelopmentDiagnostics();
  }
}

export function overlayRequestKey(bounds: {
  west: number;
  south: number;
  east: number;
  north: number;
}, zoom: number): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north]
    .map(formatOverlayCoordinate)
    .concat(String(Math.floor(zoom)))
    .join(":");
}

function overlayRequest(
  map: maplibregl.Map,
  worldApiBase: string
): { key: string; url: URL; viewport: OverlayViewport } {
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const viewport = snapOverlayViewport({
    west: canonicalOverlayCoordinate(normalizeLongitude(bounds.getWest())),
    south: canonicalOverlayCoordinate(Math.max(-90, bounds.getSouth())),
    east: canonicalOverlayCoordinate(normalizeLongitude(bounds.getEast())),
    north: canonicalOverlayCoordinate(Math.min(90, bounds.getNorth()))
  }, zoom);
  const url = new URL("/api/overlays.geojson", worldApiBase);
  url.searchParams.set(
    "bbox",
    [viewport.west, viewport.south, viewport.east, viewport.north]
      .map(formatOverlayCoordinate)
      .join(",")
  );
  url.searchParams.set("zoom", String(zoom));
  url.searchParams.set("layers", "administrative,water-no-build");
  url.searchParams.set("river_visuals", "omit");
  url.searchParams.set("lake_visuals", "omit");
  url.searchParams.set("ocean_coast_visuals", "omit");
  return { key: overlayRequestKey(viewport, zoom), url, viewport };
}

// Wide views snap the request outward to a coarse grid so small pans and pinch
// settles reuse the same key (and cached response) instead of refetching.
function overlayBboxSnapDegrees(zoom: number): number {
  if (zoom <= 10) return 0.25;
  if (zoom <= 13) return 0.05;
  return 0;
}

function snapOverlayViewport(viewport: OverlayViewport, zoom: number): OverlayViewport {
  const step = overlayBboxSnapDegrees(zoom);
  if (step === 0 || viewport.west > viewport.east) return viewport;
  return {
    west: canonicalOverlayCoordinate(Math.max(-180, Math.floor(viewport.west / step) * step)),
    south: canonicalOverlayCoordinate(Math.max(-90, Math.floor(viewport.south / step) * step)),
    east: canonicalOverlayCoordinate(Math.min(180, Math.ceil(viewport.east / step) * step)),
    north: canonicalOverlayCoordinate(Math.min(90, Math.ceil(viewport.north / step) * step))
  };
}

function removeAdministrativeViewportEdges(
  data: OverlayFeatureCollection,
  viewport: OverlayViewport
): OverlayFeatureCollection {
  const features = data.features.flatMap((feature) => {
    if (overlayFeatureKind(feature) !== "administrative") return [feature];
    const geometry = featureGeometry(feature);
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
      return [feature];
    }
    const polygons: unknown[][] = geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates.filter(Array.isArray);
    const lines = polygons.flatMap((polygon) =>
      polygon.flatMap((ring) => lineStringsWithoutViewportEdges(ring, viewport))
    );
    if (lines.length === 0) return [];
    return [{
      ...(feature as Record<string, unknown>),
      geometry: {
        type: "MultiLineString",
        coordinates: lines
      }
    }];
  });
  return { ...data, features };
}

function lineStringsWithoutViewportEdges(
  ring: unknown,
  viewport: OverlayViewport
): number[][][] {
  if (!Array.isArray(ring)) return [];
  const positions = ring.filter(isGeoJsonPosition);
  if (positions.length < 2) return [];
  const first = positions[0];
  const last = positions[positions.length - 1];
  const open = first && last && samePosition(first, last)
    ? positions.slice(0, -1)
    : positions;
  if (open.length < 2) return [];

  const segmentOnViewportEdge = open.map((position, index) =>
    isViewportEdgeSegment(position, open[(index + 1) % open.length]!, viewport)
  );
  const firstViewportEdge = segmentOnViewportEdge.findIndex(Boolean);
  if (firstViewportEdge < 0) {
    return [[...open, open[0]!].map(copyPosition)];
  }

  const lines: number[][][] = [];
  let current: number[][] = [];
  for (let offset = 1; offset <= open.length; offset += 1) {
    const index = (firstViewportEdge + offset) % open.length;
    const nextIndex = (index + 1) % open.length;
    const start = open[index]!;
    const end = open[nextIndex]!;
    if (segmentOnViewportEdge[index]) {
      if (current.length >= 2) lines.push(current);
      current = [];
      continue;
    }
    if (current.length === 0) current.push(copyPosition(start));
    current.push(copyPosition(end));
  }
  if (current.length >= 2) lines.push(current);
  return lines;
}

function isViewportEdgeSegment(
  start: number[],
  end: number[],
  viewport: OverlayViewport
): boolean {
  return (
    // World clips seam-crossing requests at ±180°; that cut is never a real border.
    (isOnAntimeridian(start[0]!) && isOnAntimeridian(end[0]!)) ||
    (
      isOnOverlayViewportCoordinate(start[0]!, viewport.west) &&
      isOnOverlayViewportCoordinate(end[0]!, viewport.west)
    ) ||
    (
      isOnOverlayViewportCoordinate(start[0]!, viewport.east) &&
      isOnOverlayViewportCoordinate(end[0]!, viewport.east)
    ) ||
    (
      isOnOverlayViewportCoordinate(start[1]!, viewport.south) &&
      isOnOverlayViewportCoordinate(end[1]!, viewport.south)
    ) ||
    (
      isOnOverlayViewportCoordinate(start[1]!, viewport.north) &&
      isOnOverlayViewportCoordinate(end[1]!, viewport.north)
    )
  );
}

function canonicalOverlayCoordinate(value: number): number {
  return Number(value.toFixed(OVERLAY_BBOX_DECIMALS));
}

function formatOverlayCoordinate(value: number): string {
  return String(canonicalOverlayCoordinate(value));
}

function isOnAntimeridian(longitude: number): boolean {
  return Math.abs(canonicalOverlayCoordinate(longitude)) === 180;
}

function isOnOverlayViewportCoordinate(value: number, viewportValue: number): boolean {
  return canonicalOverlayCoordinate(value) === viewportValue;
}

function featureGeometry(feature: unknown): {
  type: "Polygon" | "MultiPolygon" | string;
  coordinates: unknown[];
} | null {
  if (typeof feature !== "object" || feature === null) return null;
  const geometry = (feature as { geometry?: unknown }).geometry;
  if (typeof geometry !== "object" || geometry === null) return null;
  const type = (geometry as { type?: unknown }).type;
  const coordinates = (geometry as { coordinates?: unknown }).coordinates;
  return typeof type === "string" && Array.isArray(coordinates)
    ? { type, coordinates }
    : null;
}

function isGeoJsonPosition(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]);
}

function samePosition(left: number[], right: number[]): boolean {
  return near(left[0]!, right[0]!) && near(left[1]!, right[1]!);
}

function copyPosition(position: number[]): number[] {
  return [...position];
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-7;
}

function emptyFeatureCollection(): OverlayFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function isOverlayFeatureCollection(value: unknown): value is OverlayFeatureCollection {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features);
}

function overlayFeatureKind(feature: unknown): string | null {
  if (typeof feature !== "object" || feature === null) return null;
  const properties = (feature as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return null;
  const kind = (properties as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function isString(value: string | null): value is string {
  return value !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 && longitude > 0 ? 180 : normalized;
}
