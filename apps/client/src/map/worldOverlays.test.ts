// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type maplibregl from "maplibre-gl";

import {
  FRESHWATER_NORMAL_FILL_OPACITY,
  FRESHWATER_PLACEMENT_FILL_OPACITY,
  LAKE_FILL_COLOR,
  LAKE_OUTLINE_COLOR,
  OCEAN_NORMAL_FILL_OPACITY,
  OCEAN_FILL_COLOR,
  OCEAN_OUTLINE_COLOR,
  OCEAN_PLACEMENT_FILL_OPACITY,
  RIVER_FILL_COLOR,
  RIVER_OUTLINE_COLOR,
  WATER_NORMAL_OUTLINE_OPACITY,
  WATER_NORMAL_OUTLINE_WIDTH,
  WATER_PLACEMENT_OUTLINE_OPACITY,
  WATER_PLACEMENT_OUTLINE_WIDTH,
  WORLD_ADMINISTRATIVE_LAYER_ID,
  WORLD_FRESHWATER_FILL_LAYER_ID,
  WORLD_FRESHWATER_OUTLINE_LAYER_ID,
  WORLD_OCEAN_COAST_FILL_LAYER_ID,
  WORLD_OCEAN_FILL_LAYER_ID,
  WORLD_OCEAN_PERIMETER_LAYER_ID,
  WORLD_OVERLAY_DIAGNOSTICS_ID,
  WORLD_RIVER_FILL_LAYER_ID,
  WORLD_RIVER_OUTLINE_LAYER_ID,
  WORLD_WATER_VISUAL_SOURCE_ID,
  WorldOverlayPresenter
} from "./worldOverlays.js";
import { GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM } from "./mapZoomConfig.js";

describe("WorldOverlayPresenter water geometry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("orders precedence-resolved water fills and dissolved perimeters below gameplay", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const harness = mapHarness();
    new WorldOverlayPresenter(harness.map, "http://world.test");

    expect(harness.layers.map((layer) => layer.id)).toEqual([
      WORLD_OCEAN_FILL_LAYER_ID,
      WORLD_OCEAN_COAST_FILL_LAYER_ID,
      WORLD_OCEAN_PERIMETER_LAYER_ID,
      WORLD_FRESHWATER_FILL_LAYER_ID,
      WORLD_FRESHWATER_OUTLINE_LAYER_ID,
      WORLD_RIVER_FILL_LAYER_ID,
      WORLD_RIVER_OUTLINE_LAYER_ID,
      WORLD_ADMINISTRATIVE_LAYER_ID
    ]);
    expect(harness.layers[0]).toMatchObject({
      type: "fill",
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM
    });
    expect(harness.layers[1]).toMatchObject({ type: "fill" });
    expect(harness.layers[2]).toMatchObject({ type: "line" });
    expect(harness.layers[3]).toMatchObject({ type: "fill" });
    expect(harness.layers[4]).toMatchObject({ type: "line" });
    expect(harness.layers[5]).toMatchObject({ type: "fill" });
    expect(harness.layers[6]).toMatchObject({ type: "line" });
    expect(harness.layers[1]).toMatchObject({
      source: WORLD_WATER_VISUAL_SOURCE_ID,
      "source-layer": "water_ocean_surface",
      minzoom: 12,
      maxzoom: 24
    });
    expect(harness.layers[2]).toMatchObject({
      source: "world-overlays",
      filter: ["==", ["get", "kind"], "water-coastline"],
      minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM
    });
    expect(harness.layers[3]).toMatchObject({
      source: WORLD_WATER_VISUAL_SOURCE_ID,
      "source-layer": "water_lake_surface",
      minzoom: 12,
      maxzoom: 24
    });
    expect(harness.layers[4]).toMatchObject({
      source: WORLD_WATER_VISUAL_SOURCE_ID,
      "source-layer": "water_lake_perimeter",
      minzoom: 12,
      maxzoom: 24
    });
    expect(harness.layers[0]?.paint).toMatchObject({
      "fill-color": OCEAN_FILL_COLOR,
      "fill-antialias": false
    });
    expect(harness.layers[1]?.paint).toMatchObject({
      "fill-color": OCEAN_FILL_COLOR,
      "fill-antialias": false
    });
    expect(harness.layers[3]?.paint).toMatchObject({
      "fill-color": LAKE_FILL_COLOR,
      "fill-antialias": false
    });
    expect(harness.layers[4]?.paint).toMatchObject({ "line-color": LAKE_OUTLINE_COLOR });
    expect(harness.layers[5]?.paint).toMatchObject({
      "fill-color": RIVER_FILL_COLOR,
      "fill-antialias": false
    });
    expect(harness.layers[5]).toMatchObject({
      source: WORLD_WATER_VISUAL_SOURCE_ID,
      "source-layer": "water_river_surface",
      minzoom: 12,
      maxzoom: 24
    });
    expect(harness.layers[6]).toMatchObject({
      source: WORLD_WATER_VISUAL_SOURCE_ID,
      "source-layer": "water_river_perimeter"
    });
    expect(harness.layers[6]?.paint).toMatchObject({ "line-color": RIVER_OUTLINE_COLOR });
    for (const layer of [harness.layers[2], harness.layers[4], harness.layers[6]]) {
      expect(layer?.paint).not.toHaveProperty("line-dasharray");
      expect(layer?.paint).toMatchObject({
        "line-width": WATER_NORMAL_OUTLINE_WIDTH,
        "line-opacity": WATER_NORMAL_OUTLINE_OPACITY
      });
    }
    expect(harness.layers[2]?.paint).toMatchObject({ "line-color": OCEAN_OUTLINE_COLOR });
    expect(harness.layers[0]?.paint).toMatchObject({ "fill-opacity": 0.25 });
    expect(harness.layers[1]?.paint).toMatchObject({ "fill-opacity": 0.25 });
    expect(harness.layers[3]?.paint).toMatchObject({ "fill-opacity": 0.15 });
    expect(harness.layers[5]?.paint).toMatchObject({ "fill-opacity": 0.25 });
    expect(harness.layers.filter(
      (layer) => layer.source === WORLD_WATER_VISUAL_SOURCE_ID
    )).toEqual([
      harness.layers[1],
      harness.layers[3],
      harness.layers[4],
      harness.layers[5],
      harness.layers[6]
    ]);
    expect(harness.layers[7]?.paint).toMatchObject({
      "line-color": "#8a8175",
      "line-dasharray": [2, 2]
    });
    expect(harness.layers[7]).toMatchObject({ minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM });
    expect(new Set([
      (harness.layers[0]?.paint as Record<string, unknown>)["fill-color"],
      (harness.layers[3]?.paint as Record<string, unknown>)["fill-color"],
      (harness.layers[5]?.paint as Record<string, unknown>)["fill-color"],
      (harness.layers[7]?.paint as Record<string, unknown>)["line-color"]
    ])).toHaveLength(4);
    expect({
      riverFill: RIVER_FILL_COLOR,
      riverOutline: RIVER_OUTLINE_COLOR,
      oceanFill: OCEAN_FILL_COLOR,
      oceanOutline: OCEAN_OUTLINE_COLOR,
      lakeFill: LAKE_FILL_COLOR,
      lakeOutline: LAKE_OUTLINE_COLOR
    }).toEqual({
      riverFill: "#c7eaf5",
      riverOutline: "#78bdd2",
      oceanFill: "#78b6d6",
      oceanOutline: "#2f6f98",
      lakeFill: "#b8e6b8",
      lakeOutline: "#3a8f5a"
    });
    expect(harness.layers.every((layer) => !("interactive" in layer))).toBe(true);
    expect({
      oceanFillOpacity: OCEAN_NORMAL_FILL_OPACITY,
      freshwaterFillOpacity: FRESHWATER_NORMAL_FILL_OPACITY,
      outlineWidth: WATER_NORMAL_OUTLINE_WIDTH,
      outlineOpacity: WATER_NORMAL_OUTLINE_OPACITY
    }).toEqual({
      oceanFillOpacity: 0.25,
      freshwaterFillOpacity: 0.15,
      outlineWidth: 1.25,
      outlineOpacity: 1
    });
    const diagnostics = JSON.parse(
      document.getElementById(WORLD_OVERLAY_DIAGNOSTICS_ID)?.textContent ?? "null"
    ) as {
      styleOrder: string[];
      waterVisualTiles: Record<string, unknown>;
    };
    expect(diagnostics.waterVisualTiles).toMatchObject({
      sourceId: WORLD_WATER_VISUAL_SOURCE_ID,
      releaseId: "water-visual-tiles-v1",
      policy: "precedence-resolved-canonical-water-visual-v1",
      manifestSha256: "6eece70668d929850944b44ccd134a426972080aeed18865f7c360618daeb229",
      artifactSha256: "7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a",
      oceanSurfaceLayer: "water_ocean_surface",
      oceanCoastlineLayer: "water_ocean_coastline",
      lakeSurfaceLayer: "water_lake_surface",
      lakePerimeterLayer: "water_lake_perimeter",
      riverSurfaceLayer: "water_river_surface",
      riverPerimeterLayer: "water_river_perimeter",
      minZoom: 12,
      maxZoom: 14
    });
    expect(diagnostics.styleOrder.indexOf("osm")).toBeLessThan(
      diagnostics.styleOrder.indexOf(WORLD_OCEAN_FILL_LAYER_ID)
    );
    expect(diagnostics.styleOrder.indexOf(WORLD_ADMINISTRATIVE_LAYER_ID)).toBeLessThan(
      diagnostics.styleOrder.indexOf("kingdom-territory-fill")
    );
    expect(diagnostics.styleOrder.indexOf("kingdom-territory-fill")).toBeLessThan(
      diagnostics.styleOrder.indexOf("kingdom-objects")
    );
  });

  it("requests the bounded authoritative blocked-water surface", () => {
    const fetcher = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      () => new Promise<Response>(() => undefined)
    );
    vi.stubGlobal("fetch", fetcher);
    const harness = mapHarness();
    new WorldOverlayPresenter(harness.map, "http://world.test");

    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/overlays.geojson");
    expect(url.searchParams.get("layers")).toBe("administrative,water-no-build");
    expect(url.searchParams.get("river_visuals")).toBe("omit");
    expect(url.searchParams.get("lake_visuals")).toBe("omit");
    expect(url.searchParams.get("ocean_coast_visuals")).toBe("omit");
    expect(url.searchParams.get("bbox")).toBe("-106,35,-105.9,35.1");
  });

  it("clears regional geometry and skips overlay requests at the globe floor", () => {
    const fetcher = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      () => new Promise<Response>(() => undefined)
    );
    vi.stubGlobal("fetch", fetcher);
    const harness = mapHarness();
    harness.zoom.current = GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM;

    new WorldOverlayPresenter(harness.map, "http://world.test");

    expect(fetcher).not.toHaveBeenCalled();
    expect(harness.setData).toHaveBeenCalledWith({ type: "FeatureCollection", features: [] });
  });

  it("preserves the original quantized water geometry without client reconstruction", async () => {
    const quantizedSurface = {
      type: "FeatureCollection" as const,
      features: [{
        id: "water-no-build:ocean",
        properties: { kind: "water-no-build", water_kind: "ocean" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-106, 35],
            [-105.99, 35],
            [-105.99, 35.01],
            [-106, 35.01],
            [-106, 35]
          ]]
        }
      }]
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(quantizedSurface)));
    const harness = mapHarness();

    new WorldOverlayPresenter(harness.map, "http://world.test");

    await vi.waitFor(() => expect(harness.setData).toHaveBeenCalledWith(quantizedSurface));
  });

  it("removes a clipped rectangle built from the serialized six-decimal request bbox", async () => {
    const harness = mapHarness();
    Object.assign(harness.bounds, {
      west: -106.12345649,
      south: 35.12345649,
      east: -105.92345649,
      north: 35.32345649
    });
    const coordinateDeltas: number[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const bbox = requestBbox(input);
      coordinateDeltas.push(
        Math.abs(bbox[0] - harness.bounds.west),
        Math.abs(bbox[1] - harness.bounds.south),
        Math.abs(bbox[2] - harness.bounds.east),
        Math.abs(bbox[3] - harness.bounds.north)
      );
      return jsonResponse(administrativeSurface("clipped", bboxRectangle(bbox)));
    });
    vi.stubGlobal("fetch", fetcher);

    new WorldOverlayPresenter(harness.map, "http://world.test");

    await vi.waitFor(() => expect(harness.setData).toHaveBeenCalledWith({
      type: "FeatureCollection",
      features: []
    }));
    expect(Math.max(...coordinateDeltas)).toBeGreaterThan(1e-7);
  });

  it.each([
    {
      edge: "west",
      ring: ([west, south, east, north]: OverlayBbox) => [
        [west, south + 0.02],
        [west, north - 0.02],
        [(west + east) / 2, (south + north) / 2],
        [west, south + 0.02]
      ]
    },
    {
      edge: "east",
      ring: ([west, south, east, north]: OverlayBbox) => [
        [east, south + 0.02],
        [east, north - 0.02],
        [(west + east) / 2, (south + north) / 2],
        [east, south + 0.02]
      ]
    },
    {
      edge: "south",
      ring: ([west, south, east, north]: OverlayBbox) => [
        [west + 0.02, south],
        [east - 0.02, south],
        [(west + east) / 2, (south + north) / 2],
        [west + 0.02, south]
      ]
    },
    {
      edge: "north",
      ring: ([west, south, east, north]: OverlayBbox) => [
        [west + 0.02, north],
        [east - 0.02, north],
        [(west + east) / 2, (south + north) / 2],
        [west + 0.02, north]
      ]
    }
  ])("removes the serialized $edge clipping edge independently", async ({ edge, ring }) => {
    const harness = fractionalBoundsHarness();
    let expectedLine: number[][] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const clippedRing = ring(requestBbox(input));
      expectedLine = [clippedRing[1]!, clippedRing[2]!, clippedRing[0]!];
      return jsonResponse(administrativeSurface(edge, clippedRing));
    });
    vi.stubGlobal("fetch", fetcher);

    new WorldOverlayPresenter(harness.map, "http://world.test");

    await vi.waitFor(() => {
      expect(lastAdministrativeLines(harness.setData)).toEqual([expectedLine]);
    });
  });

  it("keeps interior administrative segments while removing serialized bbox edges", async () => {
    const harness = fractionalBoundsHarness();
    let expectedInterior: number[][] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const [west, south, east, north] = requestBbox(input);
      const ring = [
        [west, north],
        [(west + east) / 2, (south + north) / 2],
        [east, north],
        [west, north]
      ];
      expectedInterior = ring.slice(0, 3);
      return jsonResponse(administrativeSurface("interior", ring));
    });
    vi.stubGlobal("fetch", fetcher);

    new WorldOverlayPresenter(harness.map, "http://world.test");

    await vi.waitFor(() => {
      expect(lastAdministrativeLines(harness.setData)).toEqual([expectedInterior]);
    });
  });

  it("drops the antimeridian cut from a seam-crossing administrative outline", async () => {
    const harness = mapHarness();
    Object.assign(harness.bounds, { west: 179.99, south: -16.85, east: 180.01, north: -16.8 });
    const ring = [
      [180.00000000000003, -16.84],
      [180.00000000000003, -16.81],
      [179.995, -16.82],
      [180.00000000000003, -16.84]
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(requestBbox(input)).toEqual([179.99, -16.85, -179.99, -16.8]);
      return jsonResponse(administrativeSurface("fiji", ring));
    });
    vi.stubGlobal("fetch", fetcher);

    new WorldOverlayPresenter(harness.map, "http://world.test");

    await vi.waitFor(() => {
      expect(lastAdministrativeLines(harness.setData)).toEqual([ring.slice(1)]);
    });
  });

  it("preserves polygon holes and MultiPolygon components", async () => {
    const harness = fractionalBoundsHarness();
    let hole: number[][] = [];
    let interiorComponent: number[][] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const [west, south, east] = requestBbox(input);
      hole = [
        [west + 0.01, south + 0.02],
        [west + 0.02, south + 0.02],
        [west + 0.02, south + 0.03],
        [west + 0.01, south + 0.02]
      ];
      interiorComponent = [
        [east - 0.03, south + 0.02],
        [east - 0.01, south + 0.02],
        [east - 0.01, south + 0.04],
        [east - 0.03, south + 0.02]
      ];
      return jsonResponse({
        type: "FeatureCollection",
        features: [{
          id: "administrative:multi",
          properties: { kind: "administrative", level: "region" },
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [[
                [west, south + 0.01],
                [west, south + 0.05],
                [west + 0.04, south + 0.05],
                [west + 0.04, south + 0.01],
                [west, south + 0.01]
              ], hole],
              [interiorComponent]
            ]
          }
        }]
      });
    });
    vi.stubGlobal("fetch", fetcher);

    new WorldOverlayPresenter(harness.map, "http://world.test");

    await vi.waitFor(() => {
      const lines = lastAdministrativeLines(harness.setData) as number[][][];
      expect(lines).toHaveLength(3);
      expect(lines).toContainEqual(hole);
      expect(lines).toContainEqual(interiorComponent);
    });
  });

  it("keeps distinct cache entries for six-decimal bboxes that collide at five decimals", async () => {
    const harness = mapHarness();
    Object.assign(harness.bounds, {
      west: -106.0000014,
      south: 35.1234564,
      east: -105.9000014,
      north: 35.2234564
    });
    const requestedBboxes: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const bbox = new URL(String(input)).searchParams.get("bbox") ?? "";
      requestedBboxes.push(bbox);
      return jsonResponse(featureCollection(bbox));
    });
    vi.stubGlobal("fetch", fetcher);
    const presenter = new WorldOverlayPresenter(harness.map, "http://world.test");
    await vi.waitFor(() => {
      expect(harness.setData).toHaveBeenLastCalledWith(featureCollection(requestedBboxes[0]!));
    });

    harness.bounds.west = -106.0000044;
    await presenter.refresh();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Set(requestedBboxes)).toHaveLength(2);
    await vi.waitFor(() => {
      expect(harness.setData).toHaveBeenLastCalledWith(featureCollection(requestedBboxes[1]!));
    });

    harness.bounds.west = -106.0000012;
    await presenter.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(harness.setData).toHaveBeenLastCalledWith(featureCollection(requestedBboxes[0]!));
  });

  it("normalizes cached geometry against the viewport that produced the response", async () => {
    const sourceViewport = {
      west: -106.123456,
      south: 35.123456,
      east: -105.923456,
      north: 35.323456
    };
    const harness = mapHarness();
    Object.assign(harness.bounds, sourceViewport);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const bbox = requestBbox(input);
      return jsonResponse(administrativeSurface("cached", bboxRectangle(bbox)));
    });
    vi.stubGlobal("fetch", fetcher);
    const presenter = new WorldOverlayPresenter(harness.map, "http://world.test");
    await vi.waitFor(() => expect(harness.setData).toHaveBeenLastCalledWith({
      type: "FeatureCollection",
      features: []
    }));

    harness.bounds.west += 0.01;
    await presenter.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);

    Object.assign(harness.bounds, {
      west: sourceViewport.west - 0.0000004,
      south: sourceViewport.south + 0.0000004,
      east: sourceViewport.east - 0.0000004,
      north: sourceViewport.north + 0.0000004
    });
    await presenter.refresh();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(harness.setData).toHaveBeenLastCalledWith({
      type: "FeatureCollection",
      features: []
    });
  });

  it("widens every solid perimeter without changing translucent fills", () => {
    const fetcher = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetcher);
    const harness = mapHarness();
    const presenter = new WorldOverlayPresenter(harness.map, "http://world.test");
    const fetchCount = fetcher.mock.calls.length;

    presenter.setPlacementMode(true);

    expect(fetcher).toHaveBeenCalledTimes(fetchCount);
    expect(OCEAN_PLACEMENT_FILL_OPACITY).toBe(OCEAN_NORMAL_FILL_OPACITY);
    expect(FRESHWATER_PLACEMENT_FILL_OPACITY).toBe(FRESHWATER_NORMAL_FILL_OPACITY);
    expect(WATER_PLACEMENT_OUTLINE_WIDTH).toBeGreaterThan(WATER_NORMAL_OUTLINE_WIDTH);
    expect(WATER_PLACEMENT_OUTLINE_OPACITY).toBe(WATER_NORMAL_OUTLINE_OPACITY);
    expect({
      oceanFillOpacity: OCEAN_PLACEMENT_FILL_OPACITY,
      freshwaterFillOpacity: FRESHWATER_PLACEMENT_FILL_OPACITY,
      outlineWidth: WATER_PLACEMENT_OUTLINE_WIDTH,
      outlineOpacity: WATER_PLACEMENT_OUTLINE_OPACITY
    }).toEqual({
      oceanFillOpacity: 0.25,
      freshwaterFillOpacity: 0.15,
      outlineWidth: 1.8,
      outlineOpacity: 1
    });
    expect(harness.paint).toContainEqual([
      WORLD_OCEAN_PERIMETER_LAYER_ID,
      "line-width",
      WATER_PLACEMENT_OUTLINE_WIDTH
    ]);
    expect(harness.paint).toContainEqual([
      WORLD_RIVER_FILL_LAYER_ID,
      "fill-opacity",
      0.25
    ]);
    expect(harness.paint.filter(([, property]) => property === "line-width")).toEqual([
      [WORLD_OCEAN_PERIMETER_LAYER_ID, "line-width", WATER_NORMAL_OUTLINE_WIDTH],
      [WORLD_FRESHWATER_OUTLINE_LAYER_ID, "line-width", WATER_NORMAL_OUTLINE_WIDTH],
      [WORLD_RIVER_OUTLINE_LAYER_ID, "line-width", WATER_NORMAL_OUTLINE_WIDTH],
      [WORLD_OCEAN_PERIMETER_LAYER_ID, "line-width", WATER_PLACEMENT_OUTLINE_WIDTH],
      [WORLD_FRESHWATER_OUTLINE_LAYER_ID, "line-width", WATER_PLACEMENT_OUTLINE_WIDTH],
      [WORLD_RIVER_OUTLINE_LAYER_ID, "line-width", WATER_PLACEMENT_OUTLINE_WIDTH]
    ]);
  });

  it("restores cached geometry and layer order after a style reload without refetching", async () => {
    const cached = {
      type: "FeatureCollection" as const,
      features: [{
        id: "water-no-build:ocean",
        properties: { kind: "water-no-build", water_kind: "ocean" },
        geometry: { type: "Polygon", coordinates: [] }
      }]
    };
    const fetcher = vi.fn(async () => jsonResponse(cached));
    vi.stubGlobal("fetch", fetcher);
    const harness = mapHarness();
    new WorldOverlayPresenter(harness.map, "http://world.test");
    await vi.waitFor(() => expect(harness.setData).toHaveBeenCalledWith(cached));

    harness.clearOverlayStyle();
    harness.trigger("styledata");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(harness.addSource).toHaveBeenCalledWith(
      "world-overlays",
      expect.objectContaining({ data: cached })
    );
    expect(harness.layers.map((layer) => layer.id)).toEqual([
      WORLD_OCEAN_FILL_LAYER_ID,
      WORLD_OCEAN_COAST_FILL_LAYER_ID,
      WORLD_OCEAN_PERIMETER_LAYER_ID,
      WORLD_FRESHWATER_FILL_LAYER_ID,
      WORLD_FRESHWATER_OUTLINE_LAYER_ID,
      WORLD_RIVER_FILL_LAYER_ID,
      WORLD_RIVER_OUTLINE_LAYER_ID,
      WORLD_ADMINISTRATIVE_LAYER_ID
    ]);
    expect(harness.addSource.mock.calls.filter(
      ([id]) => id === WORLD_WATER_VISUAL_SOURCE_ID
    )).toHaveLength(2);

    harness.trigger("styledata");

    expect(harness.layers.filter((layer) => layer.id === WORLD_RIVER_FILL_LAYER_ID)).toHaveLength(1);
    expect(harness.layers.filter((layer) => layer.id === WORLD_RIVER_OUTLINE_LAYER_ID)).toHaveLength(1);
    expect(harness.addSource.mock.calls.filter(
      ([id]) => id === WORLD_WATER_VISUAL_SOURCE_ID
    )).toHaveLength(2);
    expect(harness.layers.filter(
      (layer) => layer.id === WORLD_FRESHWATER_FILL_LAYER_ID
    )).toHaveLength(1);
    expect(harness.layers.filter(
      (layer) => layer.id === WORLD_FRESHWATER_OUTLINE_LAYER_ID
    )).toHaveLength(1);
    expect(harness.layers.filter(
      (layer) => layer.id === WORLD_OCEAN_COAST_FILL_LAYER_ID
    )).toHaveLength(1);
  });

  it("publishes the real overlay contract's release identifier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      type: "FeatureCollection",
      features: [],
      metadata: { release: { release_id: "world-packages-v2" } }
    })));
    const harness = mapHarness();
    const presenter = new WorldOverlayPresenter(harness.map, "http://world.test");
    const release = vi.fn();
    presenter.subscribeRelease(release);

    await vi.waitFor(() => expect(release).toHaveBeenCalledWith("world-packages-v2"));
  });

  it("ignores stale geometry and preserves the last success when a refresh fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetcher = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    const harness = mapHarness();
    const presenter = new WorldOverlayPresenter(harness.map, "http://world.test");

    harness.bounds.west = -105.99;
    const secondRefresh = presenter.refresh();
    const newer = featureCollection("newer");
    resolveSecond(jsonResponse(newer));
    await secondRefresh;
    resolveFirst(jsonResponse(featureCollection("stale")));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.setData).toHaveBeenLastCalledWith(newer);

    harness.bounds.west = -105.98;
    await presenter.refresh();
    expect(harness.setData).toHaveBeenLastCalledWith(newer);
  });

  it("diagnoses a non-200 response and retains the last valid water geometry", async () => {
    const valid = {
      type: "FeatureCollection" as const,
      features: [{ properties: { kind: "water-no-build" }, geometry: { type: "Polygon" } }],
      metadata: {
        release: { release_id: "world-packages-v1" },
        runtime: { branch: "main", sha: "a".repeat(40) },
        capabilities: {
          flagPlacementWater: true,
          waterNoBuildOverlay: true,
          unionedWaterSurface: true
        },
        diagnostics: {
          river_surface_mode: "grid",
          selected_cell_count: 202,
          cache: "miss"
        }
      }
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse(valid))
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    vi.stubGlobal("fetch", fetcher);
    const harness = mapHarness();
    const presenter = new WorldOverlayPresenter(harness.map, "http://world.test");
    await vi.waitFor(() => expect(harness.setData).toHaveBeenCalledWith(valid));

    harness.bounds.west = -105.98;
    await presenter.refresh();

    expect(harness.setData).toHaveBeenLastCalledWith(valid);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 503 http://world.test"));
    const diagnostics = JSON.parse(
      document.getElementById(WORLD_OVERLAY_DIAGNOSTICS_ID)?.textContent ?? "null"
    ) as Record<string, unknown>;
    expect(diagnostics).toMatchObject({
      sourceFeatureCount: 1,
      waterFeatureCount: 1,
      featureKinds: ["water-no-build"],
      runtime: { branch: "main", sha: "a".repeat(40) },
      capabilities: { waterNoBuildOverlay: true },
      serverDiagnostics: {
        river_surface_mode: "grid",
        selected_cell_count: 202,
        cache: "miss"
      },
      request: {
        outcome: "http-error",
        httpStatus: 503,
        error: expect.stringContaining("HTTP 503")
      }
    });
  });

  it("distinguishes a successful zero-water viewport from request failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      type: "FeatureCollection",
      features: [{ properties: { kind: "administrative" }, geometry: { type: "Polygon" } }]
    })));
    const harness = mapHarness();
    new WorldOverlayPresenter(harness.map, "http://world.test");

    await vi.waitFor(() => {
      const diagnostics = JSON.parse(
        document.getElementById(WORLD_OVERLAY_DIAGNOSTICS_ID)?.textContent ?? "null"
      ) as Record<string, unknown>;
      expect(diagnostics).toMatchObject({
        sourceFeatureCount: 1,
        waterFeatureCount: 0,
        featureKinds: ["administrative"],
        request: { outcome: "success", httpStatus: 200, error: null }
      });
    });
  });
});

type OverlayBbox = [number, number, number, number];

function fractionalBoundsHarness(): ReturnType<typeof mapHarness> {
  const harness = mapHarness();
  Object.assign(harness.bounds, {
    west: -106.12345649,
    south: 35.12345649,
    east: -105.92345649,
    north: 35.32345649
  });
  return harness;
}

function requestBbox(input: RequestInfo | URL): OverlayBbox {
  const values = (new URL(String(input)).searchParams.get("bbox") ?? "")
    .split(",")
    .map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Expected a four-coordinate bbox request");
  }
  return values as OverlayBbox;
}

function bboxRectangle([west, south, east, north]: OverlayBbox): number[][] {
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
    [west, north]
  ];
}

function administrativeSurface(id: string, ring: number[][]): {
  type: "FeatureCollection";
  features: unknown[];
} {
  return {
    type: "FeatureCollection",
    features: [{
      id: `administrative:${id}`,
      properties: { kind: "administrative", level: "region", name: id },
      geometry: { type: "Polygon", coordinates: [ring] }
    }]
  };
}

function lastAdministrativeLines(setData: ReturnType<typeof vi.fn>): unknown {
  const data = setData.mock.calls.at(-1)?.[0] as {
    features?: Array<{ geometry?: { coordinates?: unknown } }>;
  } | undefined;
  return data?.features?.[0]?.geometry?.coordinates;
}

function mapHarness(): {
  map: maplibregl.Map;
  bounds: { west: number; south: number; east: number; north: number };
  zoom: { current: number };
  layers: Array<Record<string, unknown>>;
  paint: unknown[][];
  setData: ReturnType<typeof vi.fn>;
  addSource: ReturnType<typeof vi.fn>;
  clearOverlayStyle: () => void;
  trigger: (event: string) => void;
} {
  const bounds = { west: -106, south: 35, east: -105.9, north: 35.1 };
  const zoom = { current: 14.4 };
  const layers: Array<Record<string, unknown>> = [];
  const paint: unknown[][] = [];
  const setData = vi.fn();
  const sources = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const addSource = vi.fn((id: string) => { sources.add(id); });
  const map = {
    addSource,
    addLayer: vi.fn((layer: Record<string, unknown>) => layers.push(layer)),
    getSource: vi.fn((id: string) => sources.has(id)
      ? id === "world-overlays" ? { setData } : {}
      : undefined),
    getLayer: vi.fn((id: string) => layers.find((layer) => layer.id === id) ?? (
      id === "kingdom-territory-fill" || id === "kingdom-objects" ? { id } : undefined
    )),
    getFilter: vi.fn((id: string) => layers.find((layer) => layer.id === id)?.filter),
    getLayoutProperty: vi.fn(() => undefined),
    getPaintProperty: vi.fn((id: string, property: string) => {
      const layer = layers.find((candidate) => candidate.id === id);
      return (layer?.paint as Record<string, unknown> | undefined)?.[property];
    }),
    getStyle: vi.fn(() => ({
      layers: [{ id: "osm" }, ...layers, { id: "kingdom-territory-fill" }, { id: "kingdom-objects" }]
    })),
    getBounds: vi.fn(() => ({
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north
    })),
    getZoom: vi.fn(() => zoom.current),
    isStyleLoaded: vi.fn(() => true),
    setPaintProperty: vi.fn((...args: unknown[]) => paint.push(args)),
    on: vi.fn((event: string, listener: () => void) => {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    }),
    off: vi.fn((event: string, listener: () => void) => listeners.get(event)?.delete(listener))
  } as unknown as maplibregl.Map;
  return {
    map,
    bounds,
    zoom,
    layers,
    paint,
    setData,
    addSource,
    clearOverlayStyle: () => {
      sources.clear();
      layers.splice(0);
    },
    trigger: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    }
  };
}

function featureCollection(id: string): { type: "FeatureCollection"; features: unknown[] } {
  return { type: "FeatureCollection", features: [{ id }] };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}
