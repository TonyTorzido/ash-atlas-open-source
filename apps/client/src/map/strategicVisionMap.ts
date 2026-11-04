import {
  destinationPoint,
  distanceMeters,
  longitudeDeltaDegrees,
  type LatLon,
  type StrategicVisionAuthority,
  type StrategicVisionLandmark,
  type StrategicVisionSnapshot
} from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import { GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM } from "./mapZoomConfig.js";

const SOURCE_ID = "strategic-vision";
const BOUNDARY_FILL_LAYER_ID = "strategic-vision-fill";
const BOUNDARY_LINE_LAYER_ID = "strategic-vision-boundary";
const LANDMARK_LAYER_ID = "strategic-vision-landmarks";
const LANDMARK_LABEL_LAYER_ID = "strategic-vision-landmark-labels";

type StrategicFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.Point,
  { kind: string; name?: string }
>;

const EMPTY_COLLECTION: StrategicFeatureCollection = {
  type: "FeatureCollection",
  features: []
};

/**
 * Closed boundary ring whose longitudes stay continuous around the center, so a circle
 * crossing ±180° renders as a small ring instead of a band around the world.
 */
export function strategicBoundaryRing(center: LatLon, radiusM: number): number[][] {
  const boundary = Array.from({ length: 96 }, (_, index) => {
    const point = destinationPoint(center, radiusM, index * 360 / 96);
    return [center.lon + longitudeDeltaDegrees(center.lon, point.lon), point.lat];
  });
  boundary.push([...boundary[0]!]);
  return boundary;
}

export class StrategicVisionMapPresenter {
  private loaded = false;
  private destroyed = false;
  private pendingAuthority: StrategicVisionAuthority | null = null;
  private pendingLandmarks: StrategicVisionLandmark[] = [];
  private readonly handleIdle = (): void => {
    if (this.loaded && !this.destroyed) this.bringToFront();
  };

  constructor(private readonly map: maplibregl.Map) {
    const initialize = (): void => {
      if (this.destroyed) return;
      this.loaded = true;
      this.ensureSourceAndLayers();
      this.render();
    };
    if (map.loaded()) initialize();
    else void map.once("load", initialize);
    map.on("idle", this.handleIdle);
  }

  update(snapshot: StrategicVisionSnapshot | null): void {
    this.pendingAuthority = snapshot?.authority ?? null;
    this.pendingLandmarks = snapshot?.landmarks ?? [];
    if (this.loaded) this.render();
  }

  updateAuthority(authority: StrategicVisionAuthority | null): void {
    const currentKey = this.pendingAuthority
      ? authorityKey(this.pendingAuthority)
      : null;
    const nextKey = authority ? authorityKey(authority) : null;
    this.pendingAuthority = authority;
    if (currentKey !== nextKey) this.pendingLandmarks = [];
    if (this.loaded) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.map.off("idle", this.handleIdle);
  }

  private ensureSourceAndLayers(): void {
    if (!this.map.getSource(SOURCE_ID)) {
      this.map.addSource(SOURCE_ID, { type: "geojson", data: EMPTY_COLLECTION });
    }
    if (!this.map.getLayer(BOUNDARY_FILL_LAYER_ID)) {
      this.map.addLayer({
        id: BOUNDARY_FILL_LAYER_ID,
        type: "fill",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "boundary"],
        minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
        paint: { "fill-color": "#38bdf8", "fill-opacity": 0.025 }
      });
    }
    if (!this.map.getLayer(BOUNDARY_LINE_LAYER_ID)) {
      this.map.addLayer({
        id: BOUNDARY_LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "boundary"],
        minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
        paint: {
          "line-color": "#38bdf8",
          "line-opacity": 1,
          "line-width": 3,
          "line-dasharray": [2, 1.5]
        }
      });
    }
    if (!this.map.getLayer(LANDMARK_LAYER_ID)) {
      this.map.addLayer({
        id: LANDMARK_LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        maxzoom: 13,
        filter: ["!=", ["get", "kind"], "boundary"],
        paint: {
          "circle-radius": 7,
          "circle-color": [
            "match",
            ["get", "kind"],
            "city", "#facc15",
            "kingdom", "#fb923c",
            "manor", "#c084fc",
            "#e5e7eb"
          ],
          "circle-stroke-color": "#111827",
          "circle-stroke-width": 2
        }
      });
    }
    if (!this.map.getLayer(LANDMARK_LABEL_LAYER_ID)) {
      this.map.addLayer({
        id: LANDMARK_LABEL_LAYER_ID,
        type: "symbol",
        source: SOURCE_ID,
        maxzoom: 13,
        filter: ["!=", ["get", "kind"], "boundary"],
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-offset": [0, 1.3],
          "text-anchor": "top",
          "text-allow-overlap": false
        },
        paint: {
          "text-color": "#f8fafc",
          "text-halo-color": "#111827",
          "text-halo-width": 2
        }
      });
    }
  }

  private render(): void {
    this.ensureSourceAndLayers();
    const authority = this.pendingAuthority;
    const features: StrategicFeatureCollection["features"] = [];
    if (authority) {
      const boundary = strategicBoundaryRing(authority.center, authority.radiusM);
      features.push({
        type: "Feature",
        properties: { kind: "boundary" },
        geometry: {
          type: "Polygon",
          coordinates: [boundary]
        }
      });
      for (const landmark of this.pendingLandmarks) {
        if (distanceMeters(authority.center, landmark) <= authority.radiusM) {
          continue;
        }
        features.push({
          type: "Feature",
          properties: { kind: landmark.kind, name: landmark.name },
          geometry: { type: "Point", coordinates: [landmark.lon, landmark.lat] }
        });
      }
    }
    (this.map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)
      ?.setData({ type: "FeatureCollection", features });
    this.bringToFront();
  }

  private bringToFront(): void {
    if (this.map.getStyle().layers?.at(-1)?.id === LANDMARK_LABEL_LAYER_ID) return;
    for (const layerId of [
      BOUNDARY_FILL_LAYER_ID,
      BOUNDARY_LINE_LAYER_ID,
      LANDMARK_LAYER_ID,
      LANDMARK_LABEL_LAYER_ID
    ]) {
      if (this.map.getLayer(layerId)) this.map.moveLayer(layerId);
    }
  }
}

function authorityKey(authority: StrategicVisionAuthority): string {
  return [
    authority.center.lat,
    authority.center.lon,
    authority.radiusM,
    authority.relocationRevision,
    authority.gameplayViewGeneration
  ].join(":");
}
