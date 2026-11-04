import { WORLD_EDGE_MAX_ABS_LATITUDE } from "@ash-atlas/shared";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type maplibregl from "maplibre-gl";

/**
 * Polar fog caps beyond the world edge. MapLibre cannot blur, so the soft edge
 * is a stack of non-overlapping latitude bands whose opacity rises toward the
 * edge; everything past the edge is fully fogged. The data is static GeoJSON
 * drawn by one fill layer.
 */
export const WORLD_EDGE_FOG_SOURCE_ID = "world-edge-fog";
export const WORLD_EDGE_FOG_LAYER_ID = "world-edge-fog";
/** Dark walnut ink, like an old map's darkened margin: reads as "nothing here", not a destination. */
export const WORLD_EDGE_FOG_COLOR = "#2b2420";

/** Band start (degrees before the edge) and opacity; the last band runs to the pole. */
const WORLD_EDGE_FOG_BANDS: readonly Readonly<{ offset: number; opacity: number }>[] = [
  { offset: 0.8, opacity: 0.12 },
  { offset: 0.5, opacity: 0.26 },
  { offset: 0.3, opacity: 0.42 },
  { offset: 0.15, opacity: 0.6 },
  { offset: 0.05, opacity: 0.8 },
  { offset: 0, opacity: 1 }
];

function latitudeBand(fromAbsLat: number, toAbsLat: number, sign: 1 | -1, opacity: number): Feature<Polygon> {
  const from = sign * fromAbsLat;
  const to = sign * toAbsLat;
  return {
    type: "Feature",
    properties: { opacity },
    geometry: {
      type: "Polygon",
      coordinates: [[[-180, from], [180, from], [180, to], [-180, to], [-180, from]]]
    }
  };
}

export const WORLD_EDGE_FOG: FeatureCollection<Polygon> = {
  type: "FeatureCollection",
  features: ([1, -1] as const).flatMap((sign) =>
    WORLD_EDGE_FOG_BANDS.map((band, index) => latitudeBand(
      WORLD_EDGE_MAX_ABS_LATITUDE - band.offset,
      index === WORLD_EDGE_FOG_BANDS.length - 1
        ? 90
        : WORLD_EDGE_MAX_ABS_LATITUDE - WORLD_EDGE_FOG_BANDS[index + 1]!.offset,
      sign,
      band.opacity
    ))
  )
};

export const WORLD_EDGE_FOG_SOURCE: maplibregl.GeoJSONSourceSpecification = {
  type: "geojson",
  data: WORLD_EDGE_FOG
};

export const WORLD_EDGE_FOG_LAYER: maplibregl.FillLayerSpecification = {
  id: WORLD_EDGE_FOG_LAYER_ID,
  type: "fill",
  source: WORLD_EDGE_FOG_SOURCE_ID,
  paint: {
    "fill-color": WORLD_EDGE_FOG_COLOR,
    "fill-opacity": ["get", "opacity"],
    // Antialiased outlines would draw hairlines between adjacent bands.
    "fill-antialias": false
  }
};
