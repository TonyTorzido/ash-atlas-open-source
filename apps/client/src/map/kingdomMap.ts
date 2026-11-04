import type { KingdomStateSnapshot } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import { GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM } from "./mapZoomConfig.js";

type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, string | number | boolean | null>;
    geometry: { type: "Point"; coordinates: number[] };
  }>;
};

const EMPTY_COLLECTION: FeatureCollection = { type: "FeatureCollection", features: [] };

export class KingdomMapPresenter {
  private loaded = false;
  private destroyed = false;
  private pendingState: KingdomStateSnapshot | null = null;

  constructor(private readonly map: maplibregl.Map) {
    const initialize = (): void => {
      if (this.destroyed) return;
      this.loaded = true;
      this.ensureSourceAndLayer();
      this.render(this.pendingState);
    };
    if (map.loaded()) initialize();
    else void map.once("load", initialize);
  }

  update(state: KingdomStateSnapshot | null): void {
    this.pendingState = state;
    if (this.loaded) this.render(state);
  }

  destroy(): void {
    this.destroyed = true;
  }

  private ensureSourceAndLayer(): void {
    if (this.map.getSource("kingdom-objects")) return;
    this.map.addSource("kingdom-objects", { type: "geojson", data: EMPTY_COLLECTION });
    this.map.addLayer({
      id: "kingdom-objects",
      type: "circle",
      source: "kingdom-objects",
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      paint: {
        "circle-radius": ["case", ["==", ["get", "kind"], "cot"], 5, 6],
        "circle-color": ["case", ["==", ["get", "kind"], "cot"], "#38bdf8", "#fb923c"],
        "circle-stroke-color": "#111827",
        "circle-stroke-width": 2
      }
    });
  }

  private render(state: KingdomStateSnapshot | null): void {
    this.ensureSourceAndLayer();
    const privateObjectFeatures: FeatureCollection["features"] = [
      ...(state?.cots ?? []).filter((cot) => cot.status === "active").map((cot) => ({
        type: "Feature" as const,
        properties: { id: cot.id, kind: "cot" },
        geometry: { type: "Point" as const, coordinates: [cot.lon, cot.lat] }
      })),
      ...(state?.decorations ?? []).filter((item) => item.status === "active").map((item) => ({
        type: "Feature" as const,
        properties: { id: item.id, kind: "decoration" },
        geometry: { type: "Point" as const, coordinates: [item.lon, item.lat] }
      }))
    ];
    const nearbyObjectFeatures: FeatureCollection["features"] = (state?.nearbyObjects ?? []).map((item) => ({
      type: "Feature" as const,
      properties: { id: item.id, kind: item.kind },
      geometry: { type: "Point" as const, coordinates: [item.lon, item.lat] }
    }));
    const objectFeatures = [...new Map(
      [...nearbyObjectFeatures, ...privateObjectFeatures].map((feature) => [feature.properties.id, feature])
    ).values()];
    (this.map.getSource("kingdom-objects") as maplibregl.GeoJSONSource | undefined)
      ?.setData({ type: "FeatureCollection", features: objectFeatures });
  }
}
