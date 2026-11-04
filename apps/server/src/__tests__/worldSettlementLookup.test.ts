import { describe, expect, it } from "vitest";

import { normalizeSettlementLookup, WorldSettlementLookupError } from "../world/worldLookupClient.js";

const base = {
  source: "overture", sourceSettlementId: "source-1", name: "Albuquerque",
  countryCode: "US", regionCode: "US-NM", subtype: "locality",
  settlementClass: "city", sourceClass: "city", sourceVersion: "2026-06-17.0",
  releaseId: "world-settlements-v1", releaseFingerprint: "a".repeat(64),
  foundingPolicyId: "settlement-founding-v2", foundingPolicyFingerprint: "c".repeat(64),
  resolutionPolicyId: "primary-settlement-resolution-v1",
  resolutionPolicyFingerprint: "d".repeat(64),
  resolution: {
    policyId: "primary-settlement-resolution-v1",
    selectedAs: "primary_locality",
    candidateCount: 2
  },
  foundingEligible: true
};
const authority = {
  releaseId: "world-settlements-v1",
  releaseFingerprint: "a".repeat(64),
  foundingPolicyId: "settlement-founding-v2", foundingPolicyFingerprint: "c".repeat(64),
  resolutionPolicyId: "primary-settlement-resolution-v1",
  resolutionPolicyFingerprint: "d".repeat(64)
};

function success(settlement: Record<string, unknown>) {
  return { found: true, inside: true, authority, settlement };
}

describe("normalizeSettlementLookup", () => {
  it("prefers settlementId and safely accepts the current id field", () => {
    expect(normalizeSettlementLookup(success({ ...base, id: "old", settlementId: "new" })))
      .toMatchObject({ settlement: {
        settlementId: "new",
        source: "overture",
        sourceSettlementId: "source-1",
        settlementClass: "city",
        settlementReleaseId: "world-settlements-v1",
        settlementReleaseFingerprint: "a".repeat(64),
        foundingPolicyId: "settlement-founding-v2",
        foundingPolicyFingerprint: "c".repeat(64),
        resolutionPolicyId: "primary-settlement-resolution-v1",
        resolutionPolicyFingerprint: "d".repeat(64),
        resolution: {
          policyId: "primary-settlement-resolution-v1",
          selectedAs: "primary_locality",
          candidateCount: 2
        },
        foundingEligible: true,
        population: null,
        minimumFoundingPopulation: null,
        foundingIneligibilityReason: null,
        name: "Albuquerque"
      } });
    expect(normalizeSettlementLookup(success({ ...base, id: "old" })))
      .toMatchObject({ settlement: { settlementId: "old" } });
  });

  it("keeps v2 responses compatible when all population fields are omitted", () => {
    const lookup = normalizeSettlementLookup(success({
      ...base,
      settlementId: "settlement-1"
    }));

    expect(lookup).toMatchObject({ settlement: {
      population: null,
      minimumFoundingPopulation: null,
      foundingIneligibilityReason: null
    } });
  });

  it("normalizes accepted v3 population eligibility fields from snake or camel case", () => {
    expect(normalizeSettlementLookup(success({
      ...base,
      settlement_id: "settlement-1",
      population: 20_000,
      minimum_founding_population: 20_000,
      founding_ineligibility_reason: null
    }))).toMatchObject({ settlement: {
      population: 20_000,
      minimumFoundingPopulation: 20_000,
      foundingIneligibilityReason: null
    } });

    expect(normalizeSettlementLookup(success({
      ...base,
      settlementId: "settlement-1",
      foundingEligible: false,
      population: 19_999,
      minimumFoundingPopulation: 20_000,
      foundingIneligibilityReason: "population_below_minimum"
    }))).toMatchObject({ settlement: {
      population: 19_999,
      minimumFoundingPopulation: 20_000,
      foundingIneligibilityReason: "population_below_minimum"
    } });
  });

  it("preserves authoritative not-found instead of inventing a nearest settlement", () => {
    expect(normalizeSettlementLookup({
      found: false, inside: false, settlement: null, authority
    })).toEqual({
      found: false,
      inside: false,
      settlement: null,
      nearest: null,
      authority
    });
  });

  it("normalizes authoritative nearest-boundary distance and bearing", () => {
    expect(normalizeSettlementLookup({
      found: false,
      inside: false,
      settlement: null,
      authority,
      nearest: {
        id: "nearest-1",
        name: "Albuquerque",
        countryCode: "US",
        regionCode: "US-NM",
        regionName: "New Mexico",
        subtype: "city",
        distanceM: 3420,
        bearingDegrees: 315
      }
    })).toMatchObject({
      nearest: {
        municipalityId: "nearest-1",
        distanceM: 3420,
        bearingDegrees: 315,
        jurisdictionName: "New Mexico"
      }
    });
  });

  it("fails closed on malformed authority data", () => {
    expect(() => normalizeSettlementLookup(success({ ...base })))
      .toThrow(WorldSettlementLookupError);
    expect(() => normalizeSettlementLookup(success({
      ...base,
      settlementId: "settlement-1",
      foundingEligible: undefined
    })))
      .toThrow(WorldSettlementLookupError);
    expect(() => normalizeSettlementLookup(success({
      ...base,
      settlementId: "settlement-1",
      resolution: { ...base.resolution, candidateCount: 0 }
    })))
      .toThrow(WorldSettlementLookupError);
  });

  it.each([
    { population: -1 },
    { population: 1.5 },
    { minimum_founding_population: 0 },
    { founding_ineligibility_reason: "unknown" },
    { founding_eligible: true, founding_ineligibility_reason: "class_ineligible" },
    { founding_eligible: false, founding_ineligibility_reason: null },
    {
      population: null,
      minimum_founding_population: 20_000,
      founding_ineligibility_reason: null
    },
    {
      population: 19_999,
      minimum_founding_population: 20_000,
      founding_ineligibility_reason: null
    },
    {
      founding_eligible: false,
      population: null,
      minimum_founding_population: 20_000,
      founding_ineligibility_reason: "population_below_minimum"
    },
    {
      population: 20_000,
      minimum_founding_population: 20_000,
      minimumFoundingPopulation: 25_000,
      founding_ineligibility_reason: null
    }
  ])("fails closed on malformed or inconsistent v3 population data %#", (populationFields) => {
    expect(() => normalizeSettlementLookup(success({
      ...base,
      settlement_id: "settlement-1",
      ...populationFields
    }))).toThrow(WorldSettlementLookupError);
  });
});
