import type { CitySnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { applyCityUpdate, reconcileCitySnapshot } from "./cityReplication.js";

describe("city replication", () => {
  it("merges a scoped snapshot without removing unrelated cities", () => {
    const result = reconcileCitySnapshot(
      [city("a", "3"), city("b", "4")],
      [{ ...city("a", "5"), mayorPlayerId: "new-mayor" }]
    );

    expect(result.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(result[0]).toMatchObject({ id: "a", spatialRevision: "5", mayorPlayerId: "new-mayor" });
  });

  it("does not let a stale snapshot erase a newer city update", () => {
    const updated = applyCityUpdate(
      [city("a", "5")],
      { ...city("a", "7"), mayorPlayerId: "new-mayor" }
    );
    const afterStaleSnapshot = reconcileCitySnapshot(updated, [city("a", "6")]);

    expect(afterStaleSnapshot[0]).toMatchObject({
      spatialRevision: "7",
      mayorPlayerId: "new-mayor"
    });
  });

  it("does not let a stale delta overwrite a newer snapshot", () => {
    const snapshot = reconcileCitySnapshot([], [
      { ...city("a", "9"), mayorPlayerId: "snapshot-mayor" }
    ]);
    const afterStaleDelta = applyCityUpdate(snapshot, [
      { ...city("a", "8"), mayorPlayerId: "stale-mayor" }
    ][0]!);

    expect(afterStaleDelta[0]).toMatchObject({
      spatialRevision: "9",
      mayorPlayerId: "snapshot-mayor"
    });
  });

  it("converges for independent city updates arriving in either order", () => {
    const firstOrder = applyCityUpdate(
      applyCityUpdate([], city("b", "2")),
      city("a", "3")
    );
    const secondOrder = applyCityUpdate(
      applyCityUpdate([], city("a", "3")),
      city("b", "2")
    );

    expect(firstOrder).toEqual(secondOrder);
  });
});

function city(id: string, spatialRevision: string): CitySnapshot {
  return {
    id,
    worldId: "main",
    worldSettlementId: `settlement-${id}`,
    worldSettlementSource: "test",
    worldSourceSettlementId: `source-${id}`,
    settlementClass: "city",
    settlementReleaseId: "world-settlements-v1",
    settlementReleaseFingerprint: "f".repeat(64),
    name: `City ${id}`,
    countryCode: "US",
    regionCode: "US-NM",
    founderPlayerId: "founder",
    mayorPlayerId: "founder",
    mayorConfirmed: true,
    founderMayorClaimDeadline: null,
    seatFlagId: "00000000-0000-4000-8000-000000000001",
    lat: 35,
    lon: -106,
    active: true,
    jumpable: true,
    constructionPhase: "complete",
    constructionCompletedAt: "2026-07-10T00:00:00.000Z",
    constructionContributions: [],
    spatialRevision,
    foundingAnnexRadiusM: 750,
    createdAt: "2026-07-18T00:00:00.000Z"
  };
}
