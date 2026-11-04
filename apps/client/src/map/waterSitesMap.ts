import type { WaterSiteSnapshot } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import pearlBedUrl from "../assets/pearl-bed.png";
import whirlpoolUrl from "../assets/whirlpool.png";
import { GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM } from "./mapZoomConfig.js";
import { SPRITE_BASE_ZOOM, SPRITE_PRESENTATION } from "./spritePresentation.js";

type Feature = {
  type: "Feature";
  properties: Record<string, string | number | boolean | null>;
  geometry: { type: "Point"; coordinates: number[] };
};
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const SOURCE = "water-sites";
const PEARL_LAYER = "water-sites-pearl-beds";
const WHIRLPOOL_LAYER = "water-sites-whirlpools";
const DROWNED_LAYER = "water-sites-drowned-city";
const LAYERS = [WHIRLPOOL_LAYER, PEARL_LAYER, DROWNED_LAYER] as const;
const PEARL_IMAGE = "water-site-pearl-bed";
const WHIRLPOOL_IMAGE = "water-site-whirlpool";
/** Whirlpools turn slowly: one full turn every 12 s. */
const WHIRLPOOL_TURN_MS = 12_000;
const WHIRLPOOL_FRAME_MS = 100;

/**
 * The pearl bed shares the sulfur mine's canvas, scale and baseline (it sits a
 * touch lower on its anchor). Sizes follow the world-PNG zoom policy:
 * height = base * 2^((zoom - baseZoom) * zoomStrength).
 */
const PEARL_PRESENTATION = {
  ...SPRITE_PRESENTATION.sulfurMine,
  anchorY: Math.min(1, SPRITE_PRESENTATION.sulfurMine.anchorY + 0.03)
};
const PEARL_IMAGE_HEIGHT = 1024;
const PEARL_IMAGE_WIDTH = 1536;
const WHIRLPOOL_IMAGE_SIZE = 1024;
const WHIRLPOOL_BASE_HEIGHT_PX = 64;

function zoomScaledSize(baseHeightPx: number, imageHeightPx: number, zoomStrength: number): unknown {
  const low = SPRITE_BASE_ZOOM - 6;
  const high = SPRITE_BASE_ZOOM + 4;
  const at = (zoom: number) => baseHeightPx * 2 ** ((zoom - SPRITE_BASE_ZOOM) * zoomStrength) / imageHeightPx;
  return ["interpolate", ["exponential", 2 ** zoomStrength], ["zoom"], low, at(low), high, at(high)];
}

/**
 * Pearl Beds, whirlpools and Drowned City sites on the world map. Pearl Beds and
 * whirlpools use their final art; the Drowned City site has no art yet, so it
 * is the map's plain circle (the convention for objects whose art is missing).
 */
export class WaterSitesMapPresenter {
  private loaded = false;
  private destroyed = false;
  private pending: readonly WaterSiteSnapshot[] = [];
  private spinTimer: number | null = null;

  constructor(private readonly map: maplibregl.Map) {
    const initialize = (): void => {
      if (this.destroyed) return;
      void this.loadImages().then(() => {
        if (this.destroyed) return;
        this.loaded = true;
        this.ensureLayers();
        this.render(this.pending);
        this.spinTimer = window.setInterval(() => this.spin(), WHIRLPOOL_FRAME_MS);
      });
    };
    if (map.loaded()) initialize();
    else void map.once("load", initialize);
  }

  update(sites: readonly WaterSiteSnapshot[]): void {
    this.pending = sites;
    if (this.loaded && !this.destroyed) this.render(sites);
  }

  /** The site under a map tap (with a little finger slack), or null. */
  pickAt(point: { x: number; y: number }): string | null {
    if (!this.loaded || this.destroyed) return null;
    const layers = LAYERS.filter((layer) => this.map.getLayer(layer));
    if (layers.length === 0) return null;
    const slack = 12;
    const hits = this.map.queryRenderedFeatures(
      [[point.x - slack, point.y - slack], [point.x + slack, point.y + slack]],
      { layers: [...layers] }
    );
    const id = hits[0]?.properties?.id;
    return typeof id === "string" ? id : null;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.spinTimer !== null) window.clearInterval(this.spinTimer);
    try {
      for (const layer of LAYERS) if (this.map.getLayer(layer)) this.map.removeLayer(layer);
      if (this.map.getSource(SOURCE)) this.map.removeSource(SOURCE);
    } catch {
      // The map may already be torn down.
    }
  }

  private async loadImages(): Promise<void> {
    for (const [name, url] of [[PEARL_IMAGE, pearlBedUrl], [WHIRLPOOL_IMAGE, whirlpoolUrl]] as const) {
      if (this.map.hasImage(name)) continue;
      try {
        const image = await this.map.loadImage(url);
        if (!this.destroyed && !this.map.hasImage(name)) this.map.addImage(name, image.data);
      } catch {
        // A missing image leaves that layer empty rather than drawing a placeholder.
      }
    }
  }

  private spin(): void {
    if (this.destroyed || !this.map.getLayer(WHIRLPOOL_LAYER)) return;
    const angle = ((Date.now() % WHIRLPOOL_TURN_MS) / WHIRLPOOL_TURN_MS) * 360;
    this.map.setLayoutProperty(WHIRLPOOL_LAYER, "icon-rotate", angle);
  }

  private ensureLayers(): void {
    if (this.map.getSource(SOURCE)) return;
    this.map.addSource(SOURCE, { type: "geojson", data: EMPTY });
    this.map.addLayer({
      id: WHIRLPOOL_LAYER,
      type: "symbol",
      source: SOURCE,
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      filter: ["==", ["get", "kind"], "whirlpool"],
      layout: {
        "icon-image": WHIRLPOOL_IMAGE,
        "icon-size": zoomScaledSize(WHIRLPOOL_BASE_HEIGHT_PX, WHIRLPOOL_IMAGE_SIZE, PEARL_PRESENTATION.zoomStrength) as never,
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    });
    this.map.addLayer({
      id: PEARL_LAYER,
      type: "symbol",
      source: SOURCE,
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      filter: ["==", ["get", "kind"], "pearl_bed"],
      layout: {
        "icon-image": PEARL_IMAGE,
        "icon-size": zoomScaledSize(PEARL_PRESENTATION.baseHeightPx, PEARL_IMAGE_HEIGHT, PEARL_PRESENTATION.zoomStrength) as never,
        // Offsets are in image pixels: move the art so its anchor sits on the bed point.
        "icon-offset": [
          (0.5 - PEARL_PRESENTATION.anchorX) * PEARL_IMAGE_WIDTH,
          (0.5 - PEARL_PRESENTATION.anchorY) * PEARL_IMAGE_HEIGHT
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      },
      paint: {
        "icon-opacity": ["case", ["get", "cooling"], 0.55, 1] as never
      }
    });
    this.map.addLayer({
      id: DROWNED_LAYER,
      type: "circle",
      source: SOURCE,
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      filter: ["==", ["get", "kind"], "drowned_city_site"],
      paint: {
        "circle-radius": 8,
        "circle-color": "#1f4e5f",
        "circle-stroke-color": "#9fe3d6",
        "circle-stroke-width": 2
      }
    });
  }

  private render(sites: readonly WaterSiteSnapshot[]): void {
    this.ensureLayers();
    const now = Date.now();
    (this.map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: sites.map((site) => ({
        type: "Feature",
        properties: { id: site.siteId, kind: site.kind, cooling: (site.diveReadyAt ?? 0) > now },
        geometry: { type: "Point", coordinates: [site.lon, site.lat] }
      }))
    } as FeatureCollection as never);
  }
}
