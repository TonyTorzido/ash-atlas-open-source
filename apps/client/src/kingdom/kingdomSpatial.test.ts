import type { KingdomEnvironmentSnapshot, KingdomPublicSnapshot, KingdomStateSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { KingdomSpatialRevisionTracker } from "./kingdomSpatial.js";

describe("Kingdom spatial revision reconciliation", () => {
  it("applies one batch atomically and rejects stale or duplicate changes", () => {
    const tracker = new KingdomSpatialRevisionTracker();
    const initial = tracker.reconcileSnapshot(null, spatialState("10"));
    const moved = tracker.applyBatch(initial, [{ action: "upsert", entity: objectEntity("changed", -105.5, "11") }]);
    expect(moved.nearbyObjects?.find(({ id }) => id === "changed")?.lon).toBe(-105.5);

    const staleRemoval = tracker.applyBatch(moved, [{ action: "remove", entity: {
      entityType: "object", id: "changed", kingdomId: "kingdom-1",
      objectKind: "decoration", spatialRevision: "9"
    } }]);
    expect(staleRemoval).toBe(moved);
    expect(tracker.applyBatch(moved, [{ action: "upsert", entity: objectEntity("changed", -105.7, "11") }]))
      .toBe(moved);
  });

  it("retains newer deltas across an older snapshot and lets a newer snapshot repair state", () => {
    const tracker = new KingdomSpatialRevisionTracker();
    const initial = tracker.reconcileSnapshot(null, spatialState("20"));
    const removed = tracker.applyBatch(initial, [{ action: "remove", entity: {
      entityType: "object", id: "changed", kingdomId: "kingdom-1",
      objectKind: "decoration", spatialRevision: "21"
    } }]);
    expect(removed.nearbyObjects?.map(({ id }) => id)).toEqual(["unrelated"]);

    const older = tracker.reconcileSnapshot(removed, spatialState("19"));
    expect(older.nearbyObjects?.map(({ id }) => id)).toEqual(["unrelated"]);
    const repairedSnapshot = spatialState("22");
    repairedSnapshot.nearbyObjects = [objectEntity("changed", -104, "22").object];
    const repaired = tracker.reconcileSnapshot(older, repairedSnapshot);
    expect(repaired.nearbyObjects?.map(({ id }) => id)).toEqual(["changed"]);
  });
});

function spatialState(spatialRevision: string): KingdomStateSnapshot {
  return {
    spatialRevision, membership: null, kingdom: null, permissions: [], roster: [], invitations: [],
    chatHistory: [], treasury: [], donationHistory: null, treasuryExpenditureHistory: null,
    progression: null, advancementProject: null, activityHistory: [], cots: [], decorations: [],
    decorationCatalog: [], nearbyKingdoms: [kingdom("kingdom-1", "seat-1", -106, spatialRevision)],
    nearbyObjects: [objectEntity("unrelated", -106.2, spatialRevision).object,
      objectEntity("changed", -106, spatialRevision).object],
    freeConstruction: true, perkQualificationSeconds: 60
  };
}

function objectEntity(id: string, lon: number, spatialRevision: string) {
  return { entityType: "object" as const, id, kingdomId: "kingdom-1", objectKind: "decoration" as const,
    object: { id, kingdomId: "kingdom-1", kind: "decoration" as const, typeId: "banner" as const,
      displayName: "Banner", lat: 35, lon, rotation: 0, spatialRevision } };
}

function kingdom(id: string, seatId: string, lon: number, spatialRevision: string): KingdomPublicSnapshot {
  return { id, displayName: id, displayColor: "#7c3aed", description: null, emblemKey: null, founderPlayerId: "founder",
    leaderPlayerId: "leader", level: 1, memberCount: 1, spatialRevision, status: "active",
    seat: { id: seatId, kingdomId: id, lat: 35, lon, territoryRadiusM: 200,
      environment: environment(), environmentModifiers: [], environmentRulesVersion: 1,
      constructionState: "complete", constructionCompletesAt: null,
      completedUnderFreeConstruction: true, status: "active",
      createdAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString() };
}

function environment(): KingdomEnvironmentSnapshot {
  return { terrainClass: "plains", biome: "grassland", ecoregion: "test", elevationM: 1500,
    elevationBand: "high", slope: 2, slopeBand: "gentle", isLand: true, isSaltwater: false,
    insideMajorLake: false, worldReleaseId: "release-1", worldReleaseVersion: "2026.07",
    worldPackageId: "nm", environmentSchemaVersion: "1", environmentRulesVersion: 1,
    sourceVersions: {}, lookedUpAt: new Date(0).toISOString() };
}
