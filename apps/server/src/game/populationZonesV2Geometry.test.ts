import { describe, expect, it } from "vitest";

import {
  minimumDistanceToPopulationZoneV2,
  normalizeLongitude,
  parsePopulationZoneV2Id,
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  POPULATION_ZONE_V2_LATITUDE_BAND_COUNT,
  populationZoneV2Geometry,
  populationZoneV2Halo,
  populationZoneV2IdForPoint,
  populationZoneV2Neighbors,
  populationZonesV2IntersectingCircle
} from "./populationZonesV2Geometry.js";

describe("persistent population v2 equal-area geometry", () => {
  it("uses versioned one-kilometer bands with near-one-square-kilometer cells", () => {
    expect(POPULATION_ZONE_V2_GEOMETRY_VERSION)
      .toBe("equal-area-latitude-band-v1");
    expect(POPULATION_ZONE_V2_LATITUDE_BAND_COUNT).toBeGreaterThan(20_000);

    for (const point of [
      { lat: 0, lon: 0 },
      { lat: 45, lon: 12 },
      { lat: 80, lon: -70 },
      { lat: 89.9999, lon: 30 },
      { lat: -89.9999, lon: -150 }
    ]) {
      const geometry = populationZoneV2Geometry(
        populationZoneV2IdForPoint(point)
      );
      expect(geometry.northSouthSpanM).toBeCloseTo(1_000, 0);
      expect(geometry.areaKm2).toBeGreaterThan(0.85);
      expect(geometry.areaKm2).toBeLessThan(1.15);
      expect(populationZoneV2IdForPoint(geometry.center)).toBe(geometry.id);
    }
  });

  it("assigns canonical antimeridian and pole identities", () => {
    expect(populationZoneV2IdForPoint({ lat: 20, lon: 180 }))
      .toBe(populationZoneV2IdForPoint({ lat: 20, lon: -180 }));
    expect(populationZoneV2IdForPoint({ lat: 20, lon: 540 }))
      .toBe(populationZoneV2IdForPoint({ lat: 20, lon: -180 }));
    expect(populationZoneV2IdForPoint({ lat: 90, lon: -170 }))
      .toBe(populationZoneV2IdForPoint({ lat: 90, lon: 75 }));
    expect(populationZoneV2IdForPoint({ lat: -90, lon: -1_000 }))
      .toBe(populationZoneV2IdForPoint({ lat: -90, lon: 1_000 }));
    expect(normalizeLongitude(180)).toBe(-180);
    expect(normalizeLongitude(-540)).toBe(-180);
  });

  it("round-trips globally stable IDs and rejects non-canonical forms", () => {
    const id = populationZoneV2IdForPoint({
      lat: 29.9511,
      lon: -90.0715
    });
    const geometry = populationZoneV2Geometry(id);
    expect(parsePopulationZoneV2Id(id)).toEqual(geometry.address);
    expect(() => parsePopulationZoneV2Id(id.toUpperCase())).toThrow(
      /invalid|non-canonical/
    );
    expect(() => parsePopulationZoneV2Id("ppz2-eag1/000/zzz")).toThrow(
      /column/
    );
  });

  it("returns reciprocal edge neighbors, including across the antimeridian", () => {
    for (const point of [
      { lat: 0, lon: 179.9999 },
      { lat: 69.6492, lon: 18.9553 },
      { lat: 89.9999, lon: -179.9999 }
    ]) {
      const id = populationZoneV2IdForPoint(point);
      const neighbors = populationZoneV2Neighbors(id);
      expect(neighbors.length).toBeGreaterThanOrEqual(3);
      for (const neighbor of neighbors) {
        expect(populationZoneV2Neighbors(neighbor)).toContain(id);
      }
    }

    const datelineId = populationZoneV2IdForPoint({
      lat: 0,
      lon: 179.9999
    });
    expect(populationZoneV2Neighbors(datelineId).some((neighbor) =>
      populationZoneV2Geometry(neighbor).bounds.westLon === -180
    )).toBe(true);
  });

  it("builds inclusive deterministic graph halos", () => {
    const id = populationZoneV2IdForPoint({ lat: 40, lon: -105 });
    const ringZero = populationZoneV2Halo(id, 0);
    const ringOne = populationZoneV2Halo(id, 1);
    const ringTwo = populationZoneV2Halo(id, 2);
    expect(ringZero).toEqual([id]);
    expect(ringOne).toEqual([...ringOne].sort());
    expect(ringOne).toEqual([id, ...populationZoneV2Neighbors(id)].sort());
    expect(new Set(ringTwo).size).toBe(ringTwo.length);
    expect(ringTwo.length).toBeGreaterThan(ringOne.length);
    expect(ringOne.every((zoneId) => ringTwo.includes(zoneId))).toBe(true);
  });

  it("finds only cells whose spherical bounds intersect an activation circle", () => {
    const center = { lat: 29.9511, lon: -90.0715 };
    const radiusM = 1_500;
    const zones = populationZonesV2IntersectingCircle(center, radiusM);
    expect(zones).toContain(populationZoneV2IdForPoint(center));
    expect(zones.length).toBeGreaterThan(4);
    expect(zones.every((id) =>
      minimumDistanceToPopulationZoneV2(center, id) <= radiusM + 1e-5
    )).toBe(true);

    const centerZone = populationZoneV2Geometry(
      populationZoneV2IdForPoint(center)
    );
    expect(populationZonesV2IntersectingCircle(centerZone.center, 0))
      .toEqual([centerZone.id]);
  });

  it("keeps circle enumeration continuous across the antimeridian", () => {
    const zones = populationZonesV2IntersectingCircle(
      { lat: -16.5, lon: 179.999 },
      1_500
    );
    expect(zones.some((id) =>
      populationZoneV2Geometry(id).bounds.eastLon === 180
    )).toBe(true);
    expect(zones.some((id) =>
      populationZoneV2Geometry(id).bounds.westLon === -180
    )).toBe(true);
  });
});
