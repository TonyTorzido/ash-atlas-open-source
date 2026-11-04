import type { FeatureCollection, MultiLineString, Position } from "geojson";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

import { describe, expect, it, vi } from "vitest";
import countriesTopologyData from "world-atlas/countries-50m.json";

import {
  frameWorldMapDestinations,
  landOutlinesWithoutAntimeridianCuts,
  sanitizeWorldCountries,
  sanitizeWorldLines,
  worldMapIosResourceOptions
} from "./worldMap.js";

type WorldAtlasTopology = Topology<{
  countries: GeometryCollection;
}>;

const source = readFileSync(
  fileURLToPath(new URL("./worldMap.ts", import.meta.url)),
  "utf8"
);
const pixiOverlaySource = readFileSync(
  fileURLToPath(new URL("./pixiOverlay.ts", import.meta.url)),
  "utf8"
);
const worldMapOverlaySource = readFileSync(
  fileURLToPath(new URL("../ui/WorldMapOverlay.tsx", import.meta.url)),
  "utf8"
);
const worldMapPlayerMarkerSource = readFileSync(
  fileURLToPath(new URL("../ui/worldMapPlayerMarker.ts", import.meta.url)),
  "utf8"
);
const appSource = readFileSync(
  fileURLToPath(new URL("../App.tsx", import.meta.url)),
  "utf8"
);
const stylesSource = readFileSync(
  fileURLToPath(new URL("../styles.css", import.meta.url)),
  "utf8"
);

describe("isolated world map architecture", () => {
  it("bounds World Map GPU resources on explicit and desktop-mode iPads only", () => {
    expect(worldMapIosResourceOptions({
      userAgent: "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X)",
      platform: "iPad",
      maxTouchPoints: 5
    })).toEqual({ pixelRatio: 1, maxTileCacheZoomLevels: 1 });
    expect(worldMapIosResourceOptions({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
      platform: "MacIntel",
      maxTouchPoints: 5
    })).toEqual({ pixelRatio: 1, maxTileCacheZoomLevels: 1 });
    expect(worldMapIosResourceOptions({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
      platform: "MacIntel",
      maxTouchPoints: 0
    })).toBeUndefined();
    expect(worldMapIosResourceOptions({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      platform: "Win32",
      maxTouchPoints: 10
    })).toBeUndefined();
    expect(source).toContain(
      "const iosResourceOptions = worldMapIosResourceOptions(navigator)"
    );
    expect(source).toContain("...iosResourceOptions");
  });

  it("uses a bounded detailed MapLibre instance with label-free local world geography", () => {
    expect(source).toContain("minZoom: WORLD_MAP_MIN_ZOOM");
    expect(source).toContain("maxZoom: WORLD_MAP_DETAIL_MAX_ZOOM");
    expect(source).toContain("renderWorldCopies: false");
    expect(source).toContain('projection: { type: "globe" }');
    expect(source).toContain('map.on("moveend", () => {');
    expect(source).toContain("Math.max(-85, Math.min(85, center.lat))");
    expect(source).toContain("world-atlas/countries-50m.json");
    expect(source).not.toContain("world-atlas/countries-10m.json");
    expect(source).toContain("sanitizeWorldCountries");
    expect(source).toContain("splitAntimeridianLine");
    expect(source).toContain("MERCATOR_SOUTH_EDGE");
    expect(source).toContain('id: "world-map-land"');
    expect(source).toContain('id: "world-map-country-borders"');
    expect(source).toContain('id: "world-map-ocean"');
    expect(source).toContain('source: "world-map-ocean"');
    expect(source).toContain("syncGlobeSpaceBackground");
    expect(source).not.toContain("osmTileUrl");
    expect(source).not.toContain('type: "symbol"');
  });

  it("uses MapLibre's native globe projection across world zoom", () => {
    expect(source).toContain('projection: { type: "globe" }');
    expect(source).not.toContain("WORLD_MAP_GLOBE_ZOOM");
    expect(source).not.toContain("setProjection({ type: nextProjection })");
  });

  it("sanitizes the actual 50m country fills and borders at the antimeridian", () => {
    const topology = countriesTopologyData as unknown as WorldAtlasTopology;
    const countries = sanitizeWorldCountries(feature(
      topology,
      topology.objects.countries
    ) as FeatureCollection);
    const borders = sanitizeWorldLines(mesh(
      topology,
      topology.objects.countries,
      (left, right) => left !== right
    ) as MultiLineString);

    expect(countries.features.length).toBeGreaterThan(200);
    for (const country of countries.features) {
      for (const ring of countryRings({ type: "FeatureCollection", features: [country] })) {
        expectValidWorldLine(ring, `country ${String(country.id)}`);
      }
    }
    for (const line of borders.coordinates) expectValidWorldLine(line);

    const antarctica = countries.features.find(
      (country) => String(country.id).padStart(3, "0") === "010"
    );
    expect(antarctica).toBeTruthy();
    const antarcticaRings = countryRings({
      type: "FeatureCollection",
      features: [antarctica!]
    });
    expect(antarcticaRings).toHaveLength(108);
    expect(antarcticaRings
      .flat()
      .every((position) => position[1]! >= -85.05112878)).toBe(true);
    const mainland = antarcticaRings.find((ring) => {
      const longitudes = ring.map((position) => position[0]!);
      return Math.min(...longitudes) === -180 && Math.max(...longitudes) === 180;
    });
    expect(mainland).toBeTruthy();
    expect(Math.max(...mainland!.map((position) => position[1]!)))
      .toBeGreaterThan(-64);
    expect(mainland!.some((position) =>
      position[1] === -85.05112878 &&
      position[0] !== -180 && position[0] !== 0 && position[0] !== 180
    )).toBe(true);
    expectValidWorldLine(mainland!, "Antarctica mainland");

    const outlines = landOutlinesWithoutAntimeridianCuts(countries);
    expect(outlines.coordinates.length).toBeGreaterThan(countries.features.length);
    for (const line of outlines.coordinates) {
      for (let index = 1; index < line.length; index += 1) {
        const start = line[index - 1]!;
        const end = line[index]!;
        expect(Math.abs(start[0]!) === 180 && start[0] === end[0]).toBe(false);
      }
    }
  });

  it("frames destinations just across the antimeridian as a small area", () => {
    const fitBounds = vi.fn();
    frameWorldMapDestinations(
      { fitBounds, jumpTo: vi.fn() } as unknown as Parameters<typeof frameWorldMapDestinations>[0],
      [{ lat: -17.9, lon: -179.9 }] as unknown as Parameters<typeof frameWorldMapDestinations>[1],
      { lat: -17.8, lon: 179.9 }
    );
    const bounds = fitBounds.mock.calls[0]![0] as { getWest(): number; getEast(): number };
    expect(bounds.getEast() - bounds.getWest()).toBeCloseTo(0.2, 6);
  });

  it("uses dedicated World Map markers while regular-map landmarks retain authored structures", () => {
    for (const [structure, marker] of [
      ["structures/city-hall.png", "city-marker.png"],
      ["structures/manor.png", "manor-marker.png"],
      ["structures/kingdom-seat.png", "kingdom-seat-marker.png"]
    ]) {
      expect(pixiOverlaySource).toContain(structure);
      expect(worldMapOverlaySource).toContain(marker);
    }
  });

  it("renders the World Map player through the canonical appearance renderer", () => {
    expect(worldMapPlayerMarkerSource).toContain(
      'from "@ash-atlas/player-renderer"'
    );
    expect(worldMapPlayerMarkerSource).toContain("new PlayerRenderer(");
    expect(worldMapPlayerMarkerSource).toContain("new PixiTextureCache(playerAppearanceAssetUrl)");
    expect(worldMapPlayerMarkerSource).not.toContain("createPlayerSprite");
    expect(worldMapPlayerMarkerSource).not.toContain("<svg");
  });

  it("renders the full-height World Map player marker at HiDPI resolution", () => {
    expect(worldMapPlayerMarkerSource).toContain("const MARKER_WIDTH_PX = 36");
    expect(worldMapPlayerMarkerSource).toContain("playerMapMarkerRootScaleForRenderer");
    expect(worldMapPlayerMarkerSource).toContain(
      "playerMapMarkerRootScaleForRenderer(renderer.overallScale)"
    );
    expect(worldMapPlayerMarkerSource).toContain("playerLayerResolution");
    expect(worldMapPlayerMarkerSource).toContain("resolution: renderResolution()");
    expect(worldMapPlayerMarkerSource).toContain("roundPixels: true");
    expect(worldMapPlayerMarkerSource).toContain(
      "activeRenderer.root.getLocalBounds().y"
    );
    expect(worldMapPlayerMarkerSource).toContain(
      "app.renderer.resize(MARKER_WIDTH_PX, renderHeight)"
    );
    expect(worldMapPlayerMarkerSource).toContain(
      "renderHeight - MARKER_GROUND_PADDING_PX"
    );
    expect(worldMapPlayerMarkerSource).toMatch(
      /renderer\.root\.scale\.set\(\s*playerMapMarkerRootScaleForRenderer\(renderer\.overallScale\)\s*\*\s*scaleMultiplier/s
    );
    expect(worldMapPlayerMarkerSource).not.toContain("outer.style.height");
    expect(worldMapPlayerMarkerSource).not.toContain("inner.style.height");
    expect(stylesSource).toMatch(
      /\.world-map-player-marker\s*\{[^}]*width: 36px;[^}]*height: 36px;[^}]*overflow: visible;/s
    );
    expect(stylesSource).toMatch(
      /\.world-map-player-marker-model\s*\{[^}]*width: 36px;[^}]*height: 36px;[^}]*overflow: visible;/s
    );
    expect(stylesSource).toMatch(
      /\.world-map-player-marker-canvas\s*\{[^}]*position: absolute;[^}]*bottom: 0;[^}]*width: 100%;[^}]*height: auto;/s
    );
  });

  it("forwards the local player's appearance to the World Map overlay", () => {
    expect(appSource).toContain("{ appearance: localPlayer.appearance }");
  });

  it("opens the canonical phone World Map destination from the legacy control", () => {
    expect(appSource).toMatch(
      /onOpenWorldMap=\{\(\) => \{\s*(?:if \(locationMode !== "world"\) return;\s*)?mobileMenuNavigation\.openShortcut\("world-map"\);\s*\}\}/
    );
  });

  it("routes compact and wide game layouts to their corresponding World Map shells", () => {
    expect(appSource).toContain(
      'layout={uiEnvironment.presentation === "desktop" ? "desktop" : "phone"}'
    );
  });
});

function countryRings(collection: FeatureCollection): Position[][] {
  return collection.features.flatMap((country) => {
    if (country.geometry.type === "Polygon") return country.geometry.coordinates;
    if (country.geometry.type === "MultiPolygon") return country.geometry.coordinates.flat();
    return [];
  });
}

function expectValidWorldLine(line: Position[], label = "border"): void {
  expect(line.length).toBeGreaterThan(1);
  const invalidLongitude = line.findIndex((position) =>
    typeof position[0] !== "number" || !(position[0] >= -180 && position[0] <= 180)
  );
  expect(
    invalidLongitude,
    invalidLongitude < 0 ? undefined :
      `${label} has an invalid longitude at ${JSON.stringify(line[invalidLongitude])}`
  ).toBe(-1);
  const invalidJump = line.findIndex((position, index) =>
    index > 0 && !(Math.abs(position[0]! - line[index - 1]![0]!) <= 180)
  );
  expect(
    invalidJump,
    invalidJump < 0 ? undefined :
      `${label} crosses the antimeridian between ${JSON.stringify(line[invalidJump - 1])} and ${JSON.stringify(line[invalidJump])}`
  ).toBe(-1);
}
