import { distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  PEARL_BED_FAMILY,
  classifyWaterSiteSurface,
  domainForPoint,
  isEligibleWaterSiteSurface,
  longWhirlpoolPairs,
  waterSiteCandidateById,
  waterSiteCandidatesNear
} from "./waterSitePlacement.js";

const center = { lat: 25.7, lon: -80.1 };

describe("water site placement", () => {
  it("is deterministic and every id resolves back to the same point", () => {
    const first = waterSiteCandidatesNear(center, 20_000);
    expect(waterSiteCandidatesNear(center, 20_000)).toEqual(first);
    expect(first.some((site) => site.kind === "pearl_bed")).toBe(true);
    expect(first.some((site) => site.kind === "whirlpool")).toBe(true);
    for (const site of first) expect(waterSiteCandidateById(site.siteId)).toEqual(site);
    expect(waterSiteCandidateById("pearl:zz:zz:zz")).toBeNull();
    expect(waterSiteCandidateById("whirl:1:2:c")).toBeNull();
  });

  it("places about one Pearl Bed slot per 15 km² and keeps each in its own domain", () => {
    const beds = waterSiteCandidatesNear(center, 10_000).filter((site) => site.kind === "pearl_bed");
    const circleKm2 = Math.PI * 10 * 10;
    expect(beds.length).toBeGreaterThan(circleKm2 / 15 * 0.7);
    expect(beds.length).toBeLessThan(circleKm2 / 15 * 1.3);
    expect(new Set(beds.map((bed) => {
      const domain = domainForPoint(PEARL_BED_FAMILY, bed.position);
      return `${domain.band}:${domain.column}`;
    })).size).toBe(beds.length);
  });

  it("pairs whirlpools symmetrically, 5-50 km apart, with a few long cross-ocean pairs", () => {
    const whirlpools = waterSiteCandidatesNear(center, 200_000).filter((site) => site.kind === "whirlpool" && site.siteId.startsWith("whirl:"));
    expect(whirlpools.length).toBeGreaterThan(10);
    for (const site of whirlpools) {
      const partner = waterSiteCandidateById(site.partner!.siteId)!;
      expect(partner.partner!.siteId).toBe(site.siteId);
      const distance = distanceMeters(site.position, partner.position);
      expect(distance).toBeGreaterThanOrEqual(4_999);
      expect(distance).toBeLessThanOrEqual(50_001);
    }
    const long = longWhirlpoolPairs();
    expect(long.length).toBeGreaterThan(20);
    for (const [a, b] of long) expect(distanceMeters(a.position, b.position)).toBeGreaterThanOrEqual(1_000_000);
  });

  it("only accepts coastal ocean and lakes, and fails closed on an unknown surface", () => {
    const coastal = classifyWaterSiteSurface({ ok: true, surfaceKind: "water", waterKind: "ocean", coastlineDistanceM: 900 } as never);
    const openOcean = classifyWaterSiteSurface({ ok: true, surfaceKind: "water", waterKind: "ocean", coastlineDistanceM: 90_000 } as never);
    const lake = classifyWaterSiteSurface({ ok: true, surfaceKind: "water", waterKind: "lake" } as never);
    const majorLake = classifyWaterSiteSurface({ ok: true, surfaceKind: "water", waterKind: "lake", insideMajorLake: true } as never);
    const river = classifyWaterSiteSurface({ ok: true, surfaceKind: "water", waterKind: "river" } as never);
    const failed = classifyWaterSiteSurface({ ok: false } as never);
    expect([coastal, openOcean, lake, majorLake, river, failed]).toEqual(["coastal_ocean", "other", "lake", "major_lake", "other", "other"]);
    expect(isEligibleWaterSiteSurface("pearl_bed", lake)).toBe(true);
    expect(isEligibleWaterSiteSurface("whirlpool", lake)).toBe(false);
    expect(isEligibleWaterSiteSurface("whirlpool", majorLake)).toBe(true);
    expect(isEligibleWaterSiteSurface("drowned_city_site", lake)).toBe(false);
    expect(isEligibleWaterSiteSurface("drowned_city_site", coastal)).toBe(true);
  });
});
