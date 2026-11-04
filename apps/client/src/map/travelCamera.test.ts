import { describe, expect, it } from "vitest";

import {
  WORLD_MAP_TRAVEL_ARRIVAL_ZOOM,
  WORLD_MAP_TRAVEL_MAX_FRAME_ZOOM,
  greatCircleMidpoint,
  worldMapTravelArrivalZoom,
  worldMapTravelIntroCamera,
  worldMapTravelIntroMs
} from "./travelCamera.js";

describe("world map travel camera", () => {
  it("centres between the ends and zooms out for longer routes", () => {
    const abq = { lat: 35.08, lon: -106.65 };
    const hop = worldMapTravelIntroCamera(abq, { lat: 35.2, lon: -106.5 }, 375, 700);
    const national = worldMapTravelIntroCamera(abq, { lat: 41.88, lon: -87.63 }, 375, 700);
    const globe = worldMapTravelIntroCamera(abq, { lat: -33.9, lon: 151.2 }, 375, 700);
    // Short hops stop at a regional frame instead of diving in.
    expect(hop.zoom).toBe(WORLD_MAP_TRAVEL_MAX_FRAME_ZOOM);
    expect(national.zoom).toBeLessThan(hop.zoom);
    expect(national.zoom).toBeGreaterThan(globe.zoom);
    expect(globe.zoom).toBe(1);
    expect(national.center.lat).toBeGreaterThan(35.08);
  });

  it("fits the shorter viewport side", () => {
    const abq = { lat: 35.08, lon: -106.65 };
    const chicago = { lat: 41.88, lon: -87.63 };
    expect(worldMapTravelIntroCamera(abq, chicago, 375, 700).zoom)
      .toBeLessThan(worldMapTravelIntroCamera(abq, chicago, 1200, 800).zoom);
  });

  it("pushes in only gently on arrival", () => {
    expect(worldMapTravelArrivalZoom(1)).toBe(1.75);
    expect(worldMapTravelArrivalZoom(4.5)).toBe(WORLD_MAP_TRAVEL_ARRIVAL_ZOOM);
    expect(worldMapTravelArrivalZoom(8)).toBe(WORLD_MAP_TRAVEL_ARRIVAL_ZOOM);
  });

  it("handles the antimeridian and poles", () => {
    const mid = greatCircleMidpoint({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
    expect(Math.abs(Math.abs(mid.lon) - 180)).toBeLessThan(0.01);
    const polar = greatCircleMidpoint({ lat: -80, lon: 0 }, { lat: -80, lon: 180 });
    expect(polar.lat).toBeLessThan(-89);
  });

  it("keeps the intro short and proportional to the server-timed trip", () => {
    expect(worldMapTravelIntroMs(15_000, false)).toBe(1_100);
    expect(worldMapTravelIntroMs(15_000, true)).toBe(250);
    expect(worldMapTravelIntroMs(1_000, false)).toBe(400);
    expect(worldMapTravelIntroMs(0, false)).toBe(0);
  });
});
