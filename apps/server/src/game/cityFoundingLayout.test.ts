import {
  wgs84DestinationPoint,
  wgs84DistanceMeters
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  CITY_FOUNDING_EXPANSION_COUNT,
  buildCityFoundingLayoutCandidates,
  resolveCityFoundingLayout
} from "./cityFoundingLayout.js";

const center = { lat: 35.0844, lon: -106.6504 };

describe("city founding layout", () => {
  it("preserves the deterministic compact five-circle pentagon on open ground", () => {
    const layouts = buildCityFoundingLayoutCandidates(center, 500, 500);
    const first = resolve(layouts);
    const repeat = resolve(layouts);

    expect(first).toEqual(repeat);
    expect(first?.rotationDegrees).toBe(0);
    expect(first?.annexedFlagIds).toEqual([]);
    expect(first?.slots).toHaveLength(CITY_FOUNDING_EXPANSION_COUNT);
    expect(first?.slots.map(({ position }) =>
      Math.round(wgs84DistanceMeters(center, position))
    )).toEqual([500, 500, 500, 500, 500]);
    const neighborDistances = first!.slots.map((slot, index) =>
      Math.round(wgs84DistanceMeters(
        slot.position,
        first!.slots[(index + 1) % CITY_FOUNDING_EXPANSION_COUNT]!.position
      ))
    );
    expect(new Set(neighborDistances).size).toBe(1);
    expect(neighborDistances[0]).toBeGreaterThan(500);
  });

  it("annexes every eligible circle before creating only the missing flags", () => {
    const layouts = buildCityFoundingLayoutCandidates(center, 500, 500);
    const personalCircles = circleSet([0, 72]);
    const result = resolve(layouts, {
      personalCircles,
      blockingCircles: [
        { id: "seat", position: center, radiusM: 500 },
        ...personalCircles
      ]
    });

    expect(result?.annexedFlagIds).toEqual(["personal-0", "personal-1"]);
    expect(result?.slots).toHaveLength(CITY_FOUNDING_EXPANSION_COUNT - 2);
  });

  it("does not generate flags when annexation already satisfies the initial allocation", () => {
    const layouts = buildCityFoundingLayoutCandidates(center, 500, 500);
    const personalCircles = circleSet([0, 72, 144, 216, 288]);
    const result = resolve(layouts, {
      personalCircles,
      blockingCircles: [
        { id: "seat", position: center, radiusM: 500 },
        ...personalCircles
      ],
      isNewCircleTerrainLegal: () => false
    });

    expect(result?.annexedFlagIds).toHaveLength(CITY_FOUNDING_EXPANSION_COUNT);
    expect(result?.slots).toEqual([]);
  });

  it("moves away from a blocked weak side and recalculates after each placement", () => {
    const layouts = buildCityFoundingLayoutCandidates(center, 500, 500);
    const north = circleSet([0]);
    const blockedWorldPoints = new Set(layouts.flatMap((layout, layoutIndex) =>
      layout.slots.flatMap((slot, slotIndex) => {
        const bearing = ((slot.bearingDegrees % 360) + 360) % 360;
        return bearing === 180
          ? [layoutIndex * CITY_FOUNDING_EXPANSION_COUNT + slotIndex]
          : [];
      })
    ));
    const result = resolve(layouts, {
      personalCircles: north,
      blockingCircles: [
        { id: "seat", position: center, radiusM: 500 },
        ...north
      ],
      isNewCircleTerrainLegal: (index) => !blockedWorldPoints.has(index)
    });

    expect(result?.slots).toHaveLength(CITY_FOUNDING_EXPANSION_COUNT - 1);
    expect(result?.slots[0]?.bearingDegrees).not.toBe(180);
    expect(new Set(result?.slots.map(({ bearingDegrees }) => bearingDegrees)).size)
      .toBe(CITY_FOUNDING_EXPANSION_COUNT - 1);
  });

  it("places the first missing flag in the largest gap of an irregular annexed cluster", () => {
    const layouts = buildCityFoundingLayoutCandidates(center, 500, 500);
    const personalCircles = circleSet([0, 36, 84, 112]);
    const result = resolve(layouts, {
      personalCircles,
      blockingCircles: [
        { id: "seat", position: center, radiusM: 500 },
        ...personalCircles
      ]
    });

    expect(result?.slots).toHaveLength(1);
    expect(result?.slots[0]?.bearingDegrees).toBeGreaterThanOrEqual(200);
    expect(result?.slots[0]?.bearingDegrees).toBeLessThanOrEqual(280);
  });

  it("returns promptly when many legal candidates cannot complete an annexed layout", () => {
    const layouts = buildCityFoundingLayoutCandidates(center, 500, 500);
    const north = circleSet([0]);
    const result = resolve(layouts, {
      personalCircles: north,
      blockingCircles: [
        { id: "seat", position: center, radiusM: 500 },
        ...north
      ],
      isNewCircleTerrainLegal: (worldPointIndex) => {
        const candidate = layouts[Math.floor(worldPointIndex / CITY_FOUNDING_EXPANSION_COUNT)]!
          .slots[worldPointIndex % CITY_FOUNDING_EXPANSION_COUNT]!;
        const bearing = ((candidate.bearingDegrees % 360) + 360) % 360;
        return bearing >= 90 && bearing <= 220;
      }
    });

    expect(result).toBeNull();
  });

  it("rotates around protected territory and fails only when no fallback remains", () => {
    const layouts = buildCityFoundingLayoutCandidates(center, 500, 500);
    const defaultNorth = wgs84DestinationPoint(center, 850, 0);
    const rotated = resolve(layouts, {
      protectedCircles: [{ id: "kingdom", position: defaultNorth, radiusM: 1 }]
    });
    expect(rotated?.rotationDegrees).toBeGreaterThan(0);

    const surroundingKingdom = Array.from({ length: 12 }, (_, index) => ({
      id: `kingdom-${index}`,
      position: wgs84DestinationPoint(center, 500, index * 30),
      radiusM: 500
    }));
    expect(resolve(layouts, { protectedCircles: surroundingKingdom })).toBeNull();
  });
});

function resolve(
  layouts: ReturnType<typeof buildCityFoundingLayoutCandidates>,
  overrides: Partial<Parameters<typeof resolveCityFoundingLayout>[0]> = {}
) {
  return resolveCityFoundingLayout({
    center,
    centerRadiusM: 500,
    expansionRadiusM: 500,
    layouts,
    personalCircles: [],
    blockingCircles: [{ id: "seat", position: center, radiusM: 500 }],
    protectedCircles: [],
    isNewCircleTerrainLegal: () => true,
    ...overrides
  });
}

function circleSet(bearings: number[]) {
  return bearings.map((bearing, index) => ({
    id: `personal-${index}`,
    ownerId: "founder",
    position: wgs84DestinationPoint(center, 500.06, bearing),
    radiusM: 500
  }));
}
