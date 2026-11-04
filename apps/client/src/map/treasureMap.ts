import { TREASURE_DIG_RADIUS_M, destinationPoint, type TreasureCacheSnapshot } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import { GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM } from "./mapZoomConfig.js";

type Feature = {
  type: "Feature";
  properties: Record<string, string | number | boolean | null>;
  geometry:
    | { type: "Point"; coordinates: number[] }
    | { type: "Polygon"; coordinates: number[][][] };
};
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const REACH_SOURCE = "buried-treasure-reach";
const MARKER_SOURCE = "buried-treasure-markers";
const LAYERS = ["buried-treasure-reach-line", "buried-treasure-markers"] as const;
const REACH_SEGMENTS = 32;

/** Metal tints for the three tiers. */
const TIER_COLOR = ["match", ["get", "tier"], "gold", "#f2b705", "silver", "#cfd6dd", "#b87333"] as unknown as string;

function reachRing(cache: TreasureCacheSnapshot): number[][] {
  const ring: number[][] = [];
  for (let index = 0; index <= REACH_SEGMENTS; index += 1) {
    const point = destinationPoint(cache, TREASURE_DIG_RADIUS_M, (index / REACH_SEGMENTS) * 360);
    ring.push([point.lon, point.lat]);
  }
  return ring;
}

/**
 * Buried caches on the world map: a metal-tinted marker per cache plus its
 * dig-reach ring. No cache art exists yet, so the marker is the map's plain
 * circle (the kingdom-object convention) until art lands.
 */
export class TreasureMapPresenter {
  private loaded = false;
  private destroyed = false;
  private pending: readonly TreasureCacheSnapshot[] = [];

  constructor(private readonly map: maplibregl.Map) {
    const initialize = (): void => {
      if (this.destroyed) return;
      this.loaded = true;
      this.ensureLayers();
      this.render(this.pending);
    };
    if (map.loaded()) initialize();
    else void map.once("load", initialize);
  }

  update(caches: readonly TreasureCacheSnapshot[]): void {
    this.pending = caches;
    if (this.loaded && !this.destroyed) this.render(caches);
  }

  /** The cache marker under a map tap (with a little finger slack), or null. */
  pickAt(point: { x: number; y: number }): string | null {
    if (!this.loaded || this.destroyed || !this.map.getLayer("buried-treasure-markers")) return null;
    const slack = 10;
    const hits = this.map.queryRenderedFeatures(
      [[point.x - slack, point.y - slack], [point.x + slack, point.y + slack]],
      { layers: ["buried-treasure-markers"] }
    );
    const id = hits[0]?.properties?.id;
    return typeof id === "string" ? id : null;
  }

  destroy(): void {
    this.destroyed = true;
    try {
      for (const layer of LAYERS) if (this.map.getLayer(layer)) this.map.removeLayer(layer);
      for (const source of [REACH_SOURCE, MARKER_SOURCE]) if (this.map.getSource(source)) this.map.removeSource(source);
    } catch {
      // The map may already be torn down.
    }
  }

  private ensureLayers(): void {
    if (this.map.getSource(REACH_SOURCE)) return;
    this.map.addSource(REACH_SOURCE, { type: "geojson", data: EMPTY });
    this.map.addSource(MARKER_SOURCE, { type: "geojson", data: EMPTY });
    this.map.addLayer({
      id: "buried-treasure-reach-line",
      type: "line",
      source: REACH_SOURCE,
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      paint: {
        "line-color": TIER_COLOR,
        "line-width": 1.5,
        "line-opacity": ["case", ["get", "reachable"], 0.9, 0.35] as unknown as number,
        "line-dasharray": [2, 2]
      }
    });
    this.map.addLayer({
      id: "buried-treasure-markers",
      type: "circle",
      source: MARKER_SOURCE,
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      paint: {
        "circle-radius": 6,
        "circle-color": TIER_COLOR,
        "circle-stroke-color": ["case", ["get", "reachable"], "#ffffff", "#111827"] as unknown as string,
        "circle-stroke-width": 2
      }
    });
  }

  private render(caches: readonly TreasureCacheSnapshot[]): void {
    this.ensureLayers();
    const properties = (cache: TreasureCacheSnapshot) => ({ id: cache.id, tier: cache.tier, reachable: cache.reachable });
    (this.map.getSource(REACH_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: caches.map((cache) => ({
        type: "Feature",
        properties: properties(cache),
        geometry: { type: "Polygon", coordinates: [reachRing(cache)] }
      }))
    } as FeatureCollection as never);
    (this.map.getSource(MARKER_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: caches.map((cache) => ({
        type: "Feature",
        properties: properties(cache),
        geometry: { type: "Point", coordinates: [cache.lon, cache.lat] }
      }))
    } as FeatureCollection as never);
  }
}
