import { describe, expect, it } from "vitest";

import {
  deriveOceanSulfurDeposits,
  isAuthoritativeOceanSulfurSite,
  oceanSulfurDomainForPoint,
  OCEAN_SULFUR_ENTITY_NAMESPACE,
  OCEAN_SULFUR_PLACEMENT_VERSION,
  OCEAN_SULFUR_SLOT_NAMESPACE,
  OCEAN_SULFUR_TARGET_AREA_KM2,
  stableOceanSulfurDomainSlot
} from "./oceanSulfurPlacement.js";
import {
  populationZoneV2IdForPoint,
  populationZoneV2Neighbors
} from "./populationZonesV2Geometry.js";
import type {
  PopulationZoneV2HabitatCandidateSite,
  PopulationZoneV2Habitat
} from "./populationZonesV2Plan.js";

const WORLD_ENVIRONMENT_IDENTITY = "a".repeat(64);

function candidateSite(
  siteId: string,
  overrides: Partial<PopulationZoneV2HabitatCandidateSite> = {}
): PopulationZoneV2HabitatCandidateSite {
  const coordinate = [...siteId].reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0
  ) / 100;
  return {
    siteId,
    position: { lat: 10 + coordinate, lon: -70 },
    source: "world-profile-candidate-slot",
    sourceSampleId: `${siteId}-sample`,
    sourceCellId: `${siteId}-cell`,
    sourceSlotId: `${siteId}-slot`,
    candidateSlotVersion: "candidate-slot-v1",
    placementTags: ["ocean", "saltwater"],
    isSaltwater: true,
    insideMajorLake: false,
    surfaceType: "ocean",
    surfaceAuthority: {
      releaseId: "world-release-1",
      manifestSha256: "b".repeat(64),
      cellSizeM: 512,
      rowId: 1,
      columnId: 2
    },
    elevationBand: "sea-level",
    terrainClass: "open-water",
    landCoverClass: "open-water",
    biomeId: "ocean",
    ecoregionId: "ocean",
    spawnProfileKey: "ocean-default",
    weights: {
      eligibleLand: 0,
      tree: 0,
      deer: 0,
      wolf: 0,
      stone: 0,
      ogre: 0
    },
    ...overrides
  };
}

function habitat(
  candidateSites: readonly PopulationZoneV2HabitatCandidateSite[],
  oceanAreaKm2: number
): Pick<PopulationZoneV2Habitat, "candidateSites" | "surfaceAreaKm2"> {
  return {
    candidateSites,
    surfaceAreaKm2: {
      land: 0,
      lake: 0,
      river: 0,
      ocean: oceanAreaKm2
    }
  };
}

describe("independent ocean Sulfur placement", () => {
  it("selects one deterministic deposit per occupied global density domain", () => {
    const sites = Array.from({ length: 6 }, (_, index) =>
      candidateSite(`ocean-${String(index).padStart(2, "0")}`)
    );
    const input = {
      zoneId: "ppz2-test-ocean",
      worldEnvironmentIdentityKey: WORLD_ENVIRONMENT_IDENTITY,
      habitat: habitat(sites, OCEAN_SULFUR_TARGET_AREA_KM2 * 3 + 0.99)
    };

    const first = deriveOceanSulfurDeposits(input);
    const second = deriveOceanSulfurDeposits(input);

    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    expect(first.every((deposit) => deposit.entityKind === "sulfur")).toBe(true);
    expect(first.every((deposit) => deposit.archetype === "sulfur_mine")).toBe(true);
    expect(first.every((deposit) => deposit.environmentSnapshot.placementVersion
      === OCEAN_SULFUR_PLACEMENT_VERSION)).toBe(true);
    expect(first.every((deposit) => deposit.slotId.length > 0)).toBe(true);
    expect(first.every((deposit) => deposit.entityId.length > 0)).toBe(true);
    expect(new Set(first.map((deposit) => deposit.slotId)).size).toBe(first.length);
    expect(new Set(first.map((deposit) => deposit.entityId)).size).toBe(first.length);
  });

  it("keeps density domains stable at plan boundaries instead of rounding each plan up", () => {
    const domain = oceanSulfurDomainForPoint({ lat: 10, lon: -70 });
    const slot = stableOceanSulfurDomainSlot(
      domain,
      WORLD_ENVIRONMENT_IDENTITY
    );
    const ownerZoneId = populationZoneV2IdForPoint(slot.position);
    const nonOwnerZoneId = populationZoneV2Neighbors(ownerZoneId)[0]!;
    const site = candidateSite("boundary-domain-site", {
      position: slot.position
    });

    const ownerDeposits = deriveOceanSulfurDeposits({
      zoneId: ownerZoneId,
      worldEnvironmentIdentityKey: WORLD_ENVIRONMENT_IDENTITY,
      habitat: habitat([site], 1)
    });
    const nonOwnerDeposits = deriveOceanSulfurDeposits({
      zoneId: nonOwnerZoneId,
      worldEnvironmentIdentityKey: WORLD_ENVIRONMENT_IDENTITY,
      habitat: habitat([site], 1)
    });

    expect(ownerDeposits).toHaveLength(1);
    expect(nonOwnerDeposits).toHaveLength(0);
    expect(ownerDeposits[0]?.position).toEqual(slot.position);
  });

  it("fails closed for land, lake, non-saltwater, and missing World authority", () => {
    const land = candidateSite("land", {
      surfaceType: "land",
      isSaltwater: false,
      placementTags: ["land"]
    });
    const lake = candidateSite("lake", {
      surfaceType: "lake",
      insideMajorLake: true,
      placementTags: ["lake"]
    });
    const nonSaltwaterOcean = candidateSite("fresh-ocean", {
      isSaltwater: false
    });
    const noAuthority = candidateSite("unverified-ocean", {
      surfaceAuthority: null
    });
    const eligible = candidateSite("eligible-ocean");

    expect(isAuthoritativeOceanSulfurSite(land)).toBe(false);
    expect(isAuthoritativeOceanSulfurSite(lake)).toBe(false);
    expect(isAuthoritativeOceanSulfurSite(nonSaltwaterOcean)).toBe(false);
    expect(isAuthoritativeOceanSulfurSite(noAuthority)).toBe(false);
    expect(isAuthoritativeOceanSulfurSite(eligible)).toBe(true);

    const deposits = deriveOceanSulfurDeposits({
      zoneId: "ppz2-test-ocean",
      worldEnvironmentIdentityKey: WORLD_ENVIRONMENT_IDENTITY,
      habitat: habitat([
        land,
        lake,
        nonSaltwaterOcean,
        noAuthority,
        eligible
      ], OCEAN_SULFUR_TARGET_AREA_KM2)
    });
    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.candidateId).toContain("ocean-sulfur/");
  });

  it("uses independent identity namespaces without changing retained mine classification", () => {
    const [deposit] = deriveOceanSulfurDeposits({
      zoneId: "ppz2-test-ocean",
      worldEnvironmentIdentityKey: WORLD_ENVIRONMENT_IDENTITY,
      habitat: habitat([candidateSite("ocean-identity")], OCEAN_SULFUR_TARGET_AREA_KM2)
    });

    expect(deposit).toBeDefined();
    expect(OCEAN_SULFUR_SLOT_NAMESPACE).toBe("ocean-sulfur-deposit-slot-id-v1");
    expect(OCEAN_SULFUR_ENTITY_NAMESPACE).toBe("ocean-sulfur-deposit-entity-id-v1");
    expect(deposit?.slotId).not.toBe(deposit?.entityId);
  });

  it("materializes a representative deposit for the live one-kilometre deep-ocean plan", () => {
    const sites = Array.from({ length: 40 }, (_, index) =>
      candidateSite(`synthetic-sample/${index.toString(16)}`, {
        source: "synthetic-sample-center",
        position: {
          lat: 32.88110474022983 + index * 0.00001,
          lon: -76.57827414667942 - index * 0.00001
        },
        sourceSampleId: `population-zone-compact-samples-v3/interior/${index}`,
        sourceCellId: null,
        sourceSlotId: null,
        candidateSlotVersion: null,
        placementTags: ["general"],
        spawnProfileKey: "generic_land"
      })
    );
    const deposits = deriveOceanSulfurDeposits({
      zoneId: "ppz2-eag1/ajj/7g9$",
      worldEnvironmentIdentityKey:
        "9f8241aa2f232007a93f13288599444f5d5fc1f47e017edfd9ae3bfeb7928378",
      habitat: habitat(sites, 1.0000061131137412)
    });

    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.position.lat).toBeGreaterThan(32.881);
    expect(deposits[0]?.position.lon).toBeLessThan(-76.578);
  });
});
