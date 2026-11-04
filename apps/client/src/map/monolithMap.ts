import { destinationPoint, type MonolithSnapshot } from "@ash-atlas/shared";
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
const RANGE_SOURCE = "war-monolith-ranges";
const MARKER_SOURCE = "war-monolith-markers";
const RANGE_SEGMENTS = 48;

/** Ally / enemy tint, and a dimmed state for remnants and inert types. */
const ALLY_COLOR = "#5fb3a1";
const ENEMY_COLOR = "#d9534f";

function rangeRing(monolith: MonolithSnapshot): number[][] {
  const ring: number[][] = [];
  for (let index = 0; index <= RANGE_SEGMENTS; index += 1) {
    const point = destinationPoint(monolith, monolith.rangeRadiusM, (index / RANGE_SEGMENTS) * 360);
    ring.push([point.lon, point.lat]);
  }
  return ring;
}

/**
 * Monolith range (540 m across) and position on the world map. The
 * registered monolith PNGs have no art yet, so the marker is the map's
 * plain circle (the kingdom-object convention) until art lands.
 */
export class MonolithMapPresenter {
  private loaded = false;
  private destroyed = false;
  private pending: readonly MonolithSnapshot[] = [];

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

  update(monoliths: readonly MonolithSnapshot[]): void {
    this.pending = monoliths;
    if (this.loaded && !this.destroyed) this.render(monoliths);
  }

  destroy(): void {
    this.destroyed = true;
    try {
      for (const layer of ["war-monolith-range-fill", "war-monolith-range-line", "war-monolith-markers"]) {
        if (this.map.getLayer(layer)) this.map.removeLayer(layer);
      }
      for (const source of [RANGE_SOURCE, MARKER_SOURCE]) {
        if (this.map.getSource(source)) this.map.removeSource(source);
      }
    } catch {
      // The map may already be torn down.
    }
  }

  private ensureLayers(): void {
    if (this.map.getSource(RANGE_SOURCE)) return;
    this.map.addSource(RANGE_SOURCE, { type: "geojson", data: EMPTY });
    this.map.addSource(MARKER_SOURCE, { type: "geojson", data: EMPTY });
    const color = ["case", ["get", "allied"], ALLY_COLOR, ENEMY_COLOR] as unknown as string;
    this.map.addLayer({
      id: "war-monolith-range-fill",
      type: "fill",
      source: RANGE_SOURCE,
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      paint: {
        "fill-color": color,
        "fill-opacity": ["case", ["get", "effective"], 0.1, 0.03] as unknown as number
      }
    });
    this.map.addLayer({
      id: "war-monolith-range-line",
      type: "line",
      source: RANGE_SOURCE,
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      paint: {
        "line-color": color,
        "line-width": 2,
        "line-opacity": ["case", ["get", "effective"], 0.8, 0.35] as unknown as number,
        "line-dasharray": [2, 2]
      }
    });
    this.map.addLayer({
      id: "war-monolith-markers",
      type: "circle",
      source: MARKER_SOURCE,
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      paint: {
        "circle-radius": 7,
        "circle-color": color,
        "circle-opacity": ["case", ["get", "effective"], 1, 0.45] as unknown as number,
        "circle-stroke-color": ["case", ["get", "burning"], "#f59e0b", "#111827"] as unknown as string,
        "circle-stroke-width": ["case", ["get", "burning"], 3, 2] as unknown as number
      }
    });
  }

  private render(monoliths: readonly MonolithSnapshot[]): void {
    this.ensureLayers();
    const properties = (monolith: MonolithSnapshot) => ({
      id: monolith.id,
      type: monolith.type,
      allied: monolith.allied,
      effective: (monolith.phase === "active" || monolith.phase === "burning") && !monolith.inert,
      burning: monolith.phase === "burning"
    });
    const visible = monoliths.filter((monolith) => monolith.phase !== "gone");
    (this.map.getSource(RANGE_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: visible.map((monolith) => ({
        type: "Feature",
        properties: properties(monolith),
        geometry: { type: "Polygon", coordinates: [rangeRing(monolith)] }
      }))
    } as FeatureCollection as never);
    (this.map.getSource(MARKER_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: visible.map((monolith) => ({
        type: "Feature",
        properties: properties(monolith),
        geometry: { type: "Point", coordinates: [monolith.lon, monolith.lat] }
      }))
    } as FeatureCollection as never);
  }
}
