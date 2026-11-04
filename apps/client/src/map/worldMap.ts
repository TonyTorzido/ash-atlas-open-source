import {
  longitudeDeltaDegrees,
  WORLD_MAP_DEFAULT_ZOOM,
  WORLD_MAP_FIT_MAX_ZOOM,
  WORLD_MAP_DETAIL_MAX_ZOOM,
  WORLD_MAP_MIN_ZOOM,
  WORLD_MAP_SINGLE_DESTINATION_ZOOM,
  type WorldMapDestination
} from "@ash-atlas/shared";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiLineString,
  Position
} from "geojson";
import maplibregl from "maplibre-gl";
import polygonClipping, {
  type MultiPolygon as ClippingMultiPolygon,
  type Polygon as ClippingPolygon
} from "polygon-clipping";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countriesTopologyData from "world-atlas/countries-50m.json";

import { installMapTilesProtocol } from "./mapTilesProtocol.js";
import {
  WORLD_EDGE_FOG_LAYER,
  WORLD_EDGE_FOG_SOURCE,
  WORLD_EDGE_FOG_SOURCE_ID
} from "./worldEdgeFog.js";
import {
  syncGlobeSpaceBackground,
  WORLD_GLOBE_OCEAN
} from "./globeSpace.js";

type WorldAtlasTopology = Topology<{
  countries: GeometryCollection;
}>;

const WORLD_CLIP_POLYGON: ClippingPolygon = [[
  [-180, -90],
  [180, -90],
  [180, 90],
  [-180, 90],
  [-180, -90]
]];
const ANTARCTICA_ID = "010";
const MERCATOR_SOUTH_EDGE = -85.05112878;
const countriesTopology = countriesTopologyData as unknown as WorldAtlasTopology;
export const worldCountries = sanitizeWorldCountries(feature(
  countriesTopology,
  countriesTopology.objects.countries
) as FeatureCollection);
/** Land outlines without the synthetic ±180° cuts, which would draw a hairline seam. */
export const worldLandOutlines = landOutlinesWithoutAntimeridianCuts(worldCountries);
const worldCountryBorders = sanitizeWorldLines(mesh(
  countriesTopology,
  countriesTopology.objects.countries,
  (left, right) => left !== right
) as MultiLineString);

export type WorldMapInstance = Readonly<{
  map: maplibregl.Map;
}>;

export function worldMapIosResourceOptions(
  navigatorLike: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">
): Pick<maplibregl.MapOptions, "pixelRatio" | "maxTileCacheZoomLevels"> | undefined {
  const explicitIos = /iPad|iPhone|iPod/.test(navigatorLike.userAgent);
  const desktopModeIpad = navigatorLike.platform === "MacIntel" &&
    navigatorLike.maxTouchPoints > 1;
  return explicitIos || desktopModeIpad
    ? { pixelRatio: 1, maxTileCacheZoomLevels: 1 }
    : undefined;
}

export function createWorldMap(
  container: HTMLElement,
  fallbackCenter: { lat: number; lon: number }
): WorldMapInstance {
  installMapTilesProtocol();
  const iosResourceOptions = worldMapIosResourceOptions(navigator);
  const map = new maplibregl.Map({
    container,
    center: [fallbackCenter.lon, fallbackCenter.lat],
    zoom: WORLD_MAP_DEFAULT_ZOOM,
    minZoom: WORLD_MAP_MIN_ZOOM,
    maxZoom: WORLD_MAP_DETAIL_MAX_ZOOM,
    renderWorldCopies: false,
    dragPan: {
      linearity: 0.5,
      maxSpeed: 2200,
      deceleration: 1800
    },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false,
    ...iosResourceOptions,
    style: {
      version: 8,
      projection: { type: "globe" },
      sources: {
        "world-map-ocean": {
          type: "geojson",
          data: WORLD_GLOBE_OCEAN
        },
        "world-map-countries": {
          type: "geojson",
          data: worldCountries
        },
        "world-map-country-borders": {
          type: "geojson",
          data: worldCountryBorders
        },
        "world-map-land-outlines": {
          type: "geojson",
          data: worldLandOutlines
        },
        [WORLD_EDGE_FOG_SOURCE_ID]: WORLD_EDGE_FOG_SOURCE
      },
      layers: [
        {
          id: "world-map-ocean",
          type: "fill",
          source: "world-map-ocean",
          paint: { "fill-color": "#9fc4d1" }
        },
        {
          id: "world-map-land",
          type: "fill",
          source: "world-map-countries",
          paint: { "fill-color": "#d8d0bb" }
        },
        {
          id: "world-map-land-outline",
          type: "line",
          source: "world-map-land-outlines",
          paint: { "line-color": "#817663", "line-width": 0.75 }
        },
        {
          id: "world-map-country-borders",
          type: "line",
          source: "world-map-country-borders",
          paint: {
            "line-color": "#9b907c",
            "line-width": 0.8,
            "line-opacity": 0.8
          }
        },
        // Last style layer: environment overlays and subdivisions are inserted
        // below the borders, so the fog stays above every map layer.
        WORLD_EDGE_FOG_LAYER
      ]
    }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  map.doubleClickZoom.disable();
  map.touchZoomRotate.disableRotation();
  syncGlobeSpaceBackground(map);
  map.on("zoom", () => syncGlobeSpaceBackground(map));
  map.on("moveend", () => {
    clampWorldMapCenter(map);
  });
  return { map };
}

function clampWorldMapCenter(map: maplibregl.Map): void {
  const center = map.getCenter();
  const lon = Math.max(-180, Math.min(180, center.lng));
  const lat = Math.max(-85, Math.min(85, center.lat));
  if (lon !== center.lng || lat !== center.lat) {
    map.jumpTo({ center: [lon, lat] });
  }
}

export function sanitizeWorldCountries(
  collection: FeatureCollection
): FeatureCollection {
  return {
    ...collection,
    features: collection.features.map((country) => {
      if (country.geometry.type !== "Polygon" && country.geometry.type !== "MultiPolygon") {
        return country;
      }
      const polygons = country.geometry.type === "Polygon"
        ? [country.geometry.coordinates]
        : country.geometry.coordinates;
      const coordinates = polygons.flatMap((polygon) =>
        splitCountryPolygon(
          polygon,
          String(country.id).padStart(3, "0") === ANTARCTICA_ID
        )
      );
      return {
        ...country,
        geometry: { type: "MultiPolygon", coordinates }
      } satisfies Feature<Geometry>;
    })
  };
}

function splitCountryPolygon(
  polygon: Position[][],
  antarctica: boolean
): Position[][][] {
  if (!polygon.some(ringCrossesAntimeridian)) return [polygon];
  if (antarctica) {
    const mainlandRing = polygon.find((ring) =>
      ring.length >= 4 && ring.some((position) => position[1]! >= MERCATOR_SOUTH_EDGE)
    );
    if (!mainlandRing) return [];
    const coastline = clipRingToMercatorSouthEdge(mainlandRing);
    if (coastline.length < 3) return [];
    return [[[
      ...coastline,
      [180, MERCATOR_SOUTH_EDGE],
      [0, MERCATOR_SOUTH_EDGE],
      [-180, MERCATOR_SOUTH_EDGE],
      coastline[0]!
    ]]];
  }
  const unwrapped = polygon.map(unwrapRing) as ClippingPolygon;
  const output: ClippingMultiPolygon = [];
  for (const shift of [-360, 0, 360]) {
    const shifted = unwrapped.map((ring) =>
      ring.map(([lon, lat]) => [lon + shift, lat])
    ) as ClippingPolygon;
    output.push(...polygonClipping.intersection(shifted, WORLD_CLIP_POLYGON));
  }
  return output;
}

function clipRingToMercatorSouthEdge(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const openRing = first && last && first[0] === last[0] && first[1] === last[1]
    ? ring.slice(0, -1)
    : ring;
  if (openRing.length === 0) return [];
  const output: Position[] = [];
  let previous = openRing[openRing.length - 1]!;
  for (const position of openRing) {
    const previousInside = previous[1]! >= MERCATOR_SOUTH_EDGE;
    const positionInside = position[1]! >= MERCATOR_SOUTH_EDGE;
    if (previousInside !== positionInside) {
      const ratio = (MERCATOR_SOUTH_EDGE - previous[1]!) /
        (position[1]! - previous[1]!);
      output.push([
        previous[0]! + (position[0]! - previous[0]!) * ratio,
        MERCATOR_SOUTH_EDGE
      ]);
    }
    if (positionInside) output.push(position);
    previous = position;
  }
  return output;
}

function ringCrossesAntimeridian(ring: Position[]): boolean {
  return ring.some((position, index) => {
    const previous = ring[index - 1];
    return Boolean(previous && Math.abs(position[0]! - previous[0]!) > 180);
  });
}

function unwrapRing(ring: Position[]): [number, number][] {
  const first = ring[0];
  if (!first) return [];
  const output: [number, number][] = [[first[0]!, first[1]!]];
  let previousLon = first[0]!;
  for (const position of ring.slice(1)) {
    let lon = position[0]!;
    while (lon - previousLon > 180) lon -= 360;
    while (lon - previousLon < -180) lon += 360;
    output.push([lon, position[1]!]);
    previousLon = lon;
  }
  return output;
}

export function landOutlinesWithoutAntimeridianCuts(
  collection: FeatureCollection
): MultiLineString {
  const coordinates: Position[][] = [];
  for (const country of collection.features) {
    const geometry = country.geometry;
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") continue;
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const ring of polygons.flat()) {
      let current: Position[] = [];
      for (let index = 1; index < ring.length; index += 1) {
        const start = ring[index - 1]!;
        const end = ring[index]!;
        if (Math.abs(start[0]!) === 180 && start[0] === end[0]) {
          if (current.length > 1) coordinates.push(current);
          current = [];
          continue;
        }
        if (current.length === 0) current.push(start);
        current.push(end);
      }
      if (current.length > 1) coordinates.push(current);
    }
  }
  return { type: "MultiLineString", coordinates };
}

export function sanitizeWorldLines(lines: MultiLineString): MultiLineString {
  return {
    type: "MultiLineString",
    coordinates: lines.coordinates.flatMap(splitAntimeridianLine)
  };
}

function splitAntimeridianLine(line: Position[]): Position[][] {
  if (!ringCrossesAntimeridian(line)) return [line];
  const segments: Position[][] = [];
  let current: Position[] = [line[0]!];
  for (const position of line.slice(1)) {
    const previous = current[current.length - 1]!;
    const delta = position[0]! - previous[0]!;
    if (Math.abs(delta) <= 180) {
      current.push(position);
      continue;
    }
    const adjustedLon = position[0]! + (delta < 0 ? 360 : -360);
    const boundary = delta < 0 ? 180 : -180;
    const ratio = (boundary - previous[0]!) / (adjustedLon - previous[0]!);
    const latitude = previous[1]! + (position[1]! - previous[1]!) * ratio;
    current.push([boundary, latitude]);
    if (current.length > 1) segments.push(current);
    current = [[-boundary, latitude], position];
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

export function frameWorldMapDestinations(
  map: maplibregl.Map,
  destinations: readonly WorldMapDestination[],
  fallbackCenter: { lat: number; lon: number }
): void {
  if (destinations.length === 0) {
    map.jumpTo({
      center: [fallbackCenter.lon, fallbackCenter.lat],
      zoom: WORLD_MAP_DEFAULT_ZOOM
    });
    return;
  }
  if (destinations.length === 1) {
    const destination = destinations[0]!;
    if (
      destination.lat === fallbackCenter.lat &&
      destination.lon === fallbackCenter.lon
    ) {
      map.jumpTo({
        center: [destination.lon, destination.lat],
        zoom: WORLD_MAP_SINGLE_DESTINATION_ZOOM
      });
      return;
    }
  }
  const bounds = new maplibregl.LngLatBounds();
  bounds.extend([fallbackCenter.lon, fallbackCenter.lat]);
  // Unwrap around the player so destinations just across ±180° frame a small area.
  for (const destination of destinations) {
    bounds.extend([
      fallbackCenter.lon + longitudeDeltaDegrees(fallbackCenter.lon, destination.lon),
      destination.lat
    ]);
  }
  map.fitBounds(bounds, {
    padding: 72,
    maxZoom: WORLD_MAP_FIT_MAX_ZOOM,
    duration: 0
  });
}
