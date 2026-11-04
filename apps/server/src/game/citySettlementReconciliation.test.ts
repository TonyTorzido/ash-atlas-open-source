import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import type { SettlementLookupResult } from "../world/worldTypes.js";
import { planCitySettlementReconciliation } from "./citySettlementReconciliation.js";

const authority = {
  releaseId: "world-settlements-v2",
  releaseFingerprint: "a".repeat(64),
  foundingPolicyId: "settlement-founding-v2",
  foundingPolicyFingerprint: "b".repeat(64),
  resolutionPolicyId: "primary-settlement-resolution-v1",
  resolutionPolicyFingerprint: "c".repeat(64)
};

describe("city settlement reconciliation", () => {
  it("plans a bounded audited primary-identity change from the City Center", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [city()] });
    const lookup = vi.fn().mockResolvedValue(found("primary-a", "Chalmette"));

    const plan = await planCitySettlementReconciliation({
      pool: { query } as unknown as pg.Pool,
      lookupSettlement: lookup,
      worldId: "main",
      authority
    });

    expect(plan.ok).toBe(true);
    expect(plan.changedCount).toBe(1);
    expect(plan.reportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.changes[0]).toMatchObject({
      cityId: "00000000-0000-0000-0000-000000000010",
      seatFlagId: "00000000-0000-0000-0000-000000000020",
      before: { canonicalMunicipalityId: "vista-a", name: "Chalmette Vista" },
      after: {
        canonicalMunicipalityId: "primary-a",
        worldSettlementId: "primary-a",
        name: "Chalmette",
        settlementReleaseId: "world-settlements-v2"
      }
    });
    expect(lookup).toHaveBeenCalledWith(29.9511, -90.0715);
  });

  it("rejects two active cities resolving to the same canonical primary", async () => {
    const first = city();
    const second = city({
      id: "00000000-0000-0000-0000-000000000011",
      seat_flag_id: "00000000-0000-0000-0000-000000000021",
      seat_city_id: "00000000-0000-0000-0000-000000000011"
    });
    const query = vi.fn().mockResolvedValue({ rows: [first, second] });

    const plan = await planCitySettlementReconciliation({
      pool: { query } as unknown as pg.Pool,
      lookupSettlement: async () => found("primary-a", "Chalmette"),
      worldId: "main",
      authority
    });

    expect(plan.ok).toBe(false);
    expect(plan.conflicts).toEqual([
      {
        canonicalMunicipalityId: "primary-a",
        cityIds: [first.id, second.id]
      }
    ]);
  });

  it("is idempotent when the stored city already matches v2", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        city({
          canonical_municipality_id: "primary-a",
          world_settlement_id: "primary-a",
          world_source_settlement_id: "source-primary-a",
          settlement_class: "town",
          settlement_release_id: authority.releaseId,
          settlement_release_fingerprint: authority.releaseFingerprint,
          settlement_founding_policy_id: authority.foundingPolicyId,
          settlement_founding_policy_fingerprint: authority.foundingPolicyFingerprint,
          settlement_resolution_policy_id: authority.resolutionPolicyId,
          settlement_resolution_policy_fingerprint: authority.resolutionPolicyFingerprint,
          name: "Chalmette"
        })
      ]
    });

    const plan = await planCitySettlementReconciliation({
      pool: { query } as unknown as pg.Pool,
      lookupSettlement: async () => found("primary-a", "Chalmette"),
      worldId: "main",
      authority
    });

    expect(plan.ok).toBe(true);
    expect(plan.changedCount).toBe(0);
    expect(plan.unchangedCount).toBe(1);
  });
});

function city(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    world_id: "main",
    canonical_municipality_id: "vista-a",
    world_settlement_id: "vista-a",
    world_settlement_source: "overture",
    world_source_settlement_id: "source-vista-a",
    settlement_class: "hamlet",
    settlement_release_id: "world-settlements-v1",
    settlement_release_fingerprint: "d".repeat(64),
    settlement_founding_policy_id: authority.foundingPolicyId,
    settlement_founding_policy_fingerprint: authority.foundingPolicyFingerprint,
    settlement_resolution_policy_id: null,
    settlement_resolution_policy_fingerprint: null,
    name: "Chalmette Vista",
    country_code: "US",
    region_code: "US-LA",
    spatial_revision: "7",
    seat_flag_id: "00000000-0000-0000-0000-000000000020",
    seat_lat: 29.9511,
    seat_lon: -90.0715,
    seat_control_type: "city_seat",
    seat_city_id: "00000000-0000-0000-0000-000000000010",
    ...overrides
  };
}

function found(settlementId: string, name: string): SettlementLookupResult {
  return {
    found: true,
    inside: true,
    nearest: null,
    authority,
    settlement: {
      settlementId,
      source: "overture",
      sourceSettlementId: `source-${settlementId}`,
      sourceClass: "town",
      name,
      countryCode: "US",
      regionCode: "US-LA",
      jurisdictionName: "Saint Bernard Parish",
      subtype: "town",
      settlementClass: "town",
      administrativeLevel: "locality",
      sourceVersion: "2026-06-17.0",
      settlementReleaseId: authority.releaseId,
      settlementReleaseFingerprint: authority.releaseFingerprint,
      foundingPolicyId: authority.foundingPolicyId,
      foundingPolicyFingerprint: authority.foundingPolicyFingerprint,
      resolutionPolicyId: authority.resolutionPolicyId,
      resolutionPolicyFingerprint: authority.resolutionPolicyFingerprint,
      resolution: {
        policyId: authority.resolutionPolicyId,
        selectedAs: "primary_locality",
        candidateCount: 1
      },
      foundingEligible: true,
      population: null,
      minimumFoundingPopulation: null,
      foundingIneligibilityReason: null
    }
  };
}
