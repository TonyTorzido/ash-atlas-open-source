import {
  destinationPoint,
  type TravelServerMessage,
  type WorldMapDestination
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  WORLD_MAP_DISTANCE_AT_MAX_DURATION_M,
  WORLD_MAP_TRAVEL_MAX_MS,
  WORLD_MAP_TRAVEL_MIN_MS,
  worldMapTravelDurationMs,
  worldMapTravelFrameOutcome,
  worldMapTravelReducer,
  type ActiveWorldMapTravelState
} from "./worldMapTravelModel.js";

const origin = { lat: 35, lon: -106 };
const city: WorldMapDestination = {
  kind: "city",
  id: "city-a",
  name: "Albuquerque",
  lat: 36,
  lon: -105
};

function active(
  destination: WorldMapDestination = city
): ActiveWorldMapTravelState {
  return {
    phase: "travelling",
    requestId: "request-a",
    origin,
    destination,
    startedAtMs: 100,
    durationMs: 7_000,
    authoritativeSuccess: false,
    presentationComplete: false
  };
}

describe("World Map travel model", () => {
  it("takes the minimum time at the origin and fifteen seconds at the antipode", () => {
    expect(worldMapTravelDurationMs(origin, origin)).toBe(
      WORLD_MAP_TRAVEL_MIN_MS
    );
    expect(worldMapTravelDurationMs(origin, { lat: -origin.lat, lon: origin.lon + 180 })).toBeCloseTo(
      WORLD_MAP_TRAVEL_MAX_MS, 3
    );
    expect(worldMapTravelDurationMs({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }))
      .toBe(WORLD_MAP_TRAVEL_MAX_MS);
  });

  it("scales intermediate distances linearly", () => {
    const halfway = destinationPoint(
      origin,
      WORLD_MAP_DISTANCE_AT_MAX_DURATION_M / 2,
      90
    );
    expect(worldMapTravelDurationMs(origin, halfway)).toBeCloseTo(7_500, 6);
  });

  it("uses the short wrapped distance across the date line", () => {
    expect(worldMapTravelDurationMs({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }))
      .toBe(WORLD_MAP_TRAVEL_MIN_MS);
  });

  it("waits for both presentation completion and authoritative success", () => {
    const succeededEarly = worldMapTravelReducer(active(), {
      type: "authoritative_success",
      requestId: "request-a"
    });
    expect(succeededEarly).toMatchObject({
      phase: "travelling",
      authoritativeSuccess: true,
      presentationComplete: false
    });

    const preparing = worldMapTravelReducer(active(), {
      type: "presentation_complete",
      requestId: "request-a"
    });
    expect(preparing.phase).toBe("preparing");

    const arriving = worldMapTravelReducer(preparing, {
      type: "authoritative_success",
      requestId: "request-a"
    });
    expect(arriving.phase).toBe("arriving");
  });

  it("matches city, Kingdom-seat, Atlas Shrine, and manor success by request and destination", () => {
    const cityFrame = {
      type: "CITY_VISITED",
      requestId: "request-a",
      cityId: "city-a"
    } as TravelServerMessage;
    expect(worldMapTravelFrameOutcome(active(), cityFrame)?.type).toBe("success");

    const kingdom: WorldMapDestination = {
      kind: "kingdom",
      id: "kingdom-a",
      seatId: "seat-a",
      name: "Ash Realm",
      lat: 37,
      lon: -104
    };
    const flagFrame = {
      type: "FLAG_VISITED",
      requestId: "request-a",
      flagId: "seat-a"
    } as TravelServerMessage;
    expect(worldMapTravelFrameOutcome(active(kingdom), flagFrame)?.type).toBe("success");

    const shrine: WorldMapDestination = {
      kind: "atlas_shrine",
      id: "shrine-a",
      name: "North Shrine",
      lat: 37,
      lon: -104
    };
    expect(worldMapTravelFrameOutcome(active(shrine), {
      type: "FLAG_VISITED",
      requestId: "request-a",
      flagId: "shrine-a"
    } as TravelServerMessage)?.type).toBe("success");

    const manor: WorldMapDestination = {
      kind: "manor",
      id: "manor-a",
      name: "Your Manor",
      lat: 36,
      lon: -105
    };
    const manorFrame = {
      type: "TRAVEL_RESULT",
      requestId: "request-a",
      kind: "manor_jump",
      success: true,
      message: "Jumped to manor."
    } satisfies TravelServerMessage;
    expect(worldMapTravelFrameOutcome(active(manor), manorFrame)?.type).toBe("success");
  });

  it("ignores another request ID and restores a matching failure", () => {
    const other = {
      type: "CITY_VISITED",
      requestId: "request-b",
      cityId: "city-a"
    } as TravelServerMessage;
    expect(worldMapTravelFrameOutcome(active(), other)).toBeNull();

    const manor = {
      kind: "manor" as const,
      id: "manor-a",
      name: "Your Manor",
      lat: 36,
      lon: -105
    };
    expect(worldMapTravelFrameOutcome(active(manor), {
      type: "MANOR_ERROR",
      requestId: "request-a",
      code: "MANOR_JUMP_FAILED",
      message: "The manor is unavailable."
    })).toEqual({
      type: "failure",
      requestId: "request-a",
      message: "The manor is unavailable."
    });

    const failed = worldMapTravelReducer(active(), {
      type: "failed",
      requestId: "request-a",
      message: "Travel is blocked."
    });
    expect(failed).toMatchObject({
      phase: "failed",
      origin,
      destination: city,
      message: "Travel is blocked."
    });
  });
});
