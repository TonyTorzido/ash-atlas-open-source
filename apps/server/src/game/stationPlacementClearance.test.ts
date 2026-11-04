import { destinationPoint, distanceMeters } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";
import { OUTDOOR_STATION_CLEARANCE_M, evaluateOutdoorStationClearance } from "./stationPlacementClearance.js";

describe("outdoor station placement clearance", () => {
  const existing = { lat: 35.0845, lon: -106.6504 };

  it("rejects cross-type or constructing station points inside 30m and suggests a retryable point", () => {
    const evaluation = evaluateOutdoorStationClearance(existing, [existing]);
    expect(evaluation.allowed).toBe(false);
    if (evaluation.allowed) return;
    expect(evaluation.suggestedPosition).toBeDefined();
    expect(distanceMeters(existing, evaluation.suggestedPosition!)).toBeGreaterThanOrEqual(OUTDOOR_STATION_CLEARANCE_M);
    expect(evaluateOutdoorStationClearance(evaluation.suggestedPosition!, [existing])).toEqual({ allowed: true });
  });

  it("allows a placement at the exact minimum clearance", () => {
    const safe = { lat: 35.0848, lon: -106.6504 };
    expect(distanceMeters(existing, safe)).toBeGreaterThan(OUTDOOR_STATION_CLEARANCE_M);
    expect(evaluateOutdoorStationClearance(safe, [existing])).toEqual({ allowed: true });
  });

  it("suggests the nearby boundary rather than moving a near-miss another 30m", () => {
    const requested = destinationPoint(existing, 29, 90);
    const evaluation = evaluateOutdoorStationClearance(requested, [existing]);
    expect(evaluation.allowed).toBe(false);
    if (evaluation.allowed) return;
    expect(distanceMeters(requested, evaluation.suggestedPosition!)).toBeLessThan(3);
  });

  it("keeps a suggestion inside the Manor build radius near its boundary", () => {
    const manorCenter = { lat: 35, lon: -106 };
    const requested = destinationPoint(manorCenter, 649, 90);
    const evaluation = evaluateOutdoorStationClearance(requested, [requested], {
      manorCenter,
      maxManorDistanceM: 650,
      movementAnchor: manorCenter,
      moveLeashRadiusM: 2_000
    });
    expect(evaluation.allowed).toBe(false);
    if (evaluation.allowed) return;
    expect(evaluation.suggestedPosition).toBeDefined();
    expect(distanceMeters(manorCenter, evaluation.suggestedPosition!)).toBeLessThanOrEqual(650);
    expect(evaluateOutdoorStationClearance(evaluation.suggestedPosition!, [requested])).toEqual({ allowed: true });
  });

  it("keeps a suggestion inside the movement leash near its boundary", () => {
    const movementAnchor = { lat: 35, lon: -106 };
    const requested = destinationPoint(movementAnchor, 99, 180);
    const evaluation = evaluateOutdoorStationClearance(requested, [requested], {
      manorCenter: movementAnchor,
      maxManorDistanceM: 650,
      movementAnchor,
      moveLeashRadiusM: 100
    });
    expect(evaluation.allowed).toBe(false);
    if (evaluation.allowed) return;
    expect(evaluation.suggestedPosition).toBeDefined();
    expect(distanceMeters(movementAnchor, evaluation.suggestedPosition!)).toBeLessThanOrEqual(100);
    expect(evaluateOutdoorStationClearance(evaluation.suggestedPosition!, [requested])).toEqual({ allowed: true });
  });
});
