import { describe, expect, it } from "vitest";

import {
  hashPartsHex,
  permanentMineKindForSlot,
  deterministicUuidV8,
  populationEnvironmentArtifactIdentity,
  populationGenerationRecipeIdentity,
  populationZoneV2PlanId,
  populationZoneV2PlanIdentity,
  type PopulationZoneV2PlanIdentity,
  samePopulationZoneV2PlanAuthority
} from "./populationZonesV2Identity.js";

const WORLD_IDENTITY_A = "a".repeat(64);
const WORLD_IDENTITY_B = "b".repeat(64);

describe("canonical Population V2 plan authority", () => {
  it("classifies permanent mine slots deterministically into an even mix", () => {
    const slots = Array.from({ length: 3_000 }, (_, index) =>
      deterministicUuidV8("permanent-mine-kind-test", { index })
    );
    const first = slots.map(permanentMineKindForSlot);
    const second = slots.map(permanentMineKindForSlot);
    expect(second).toEqual(first);

    const counts = first.reduce<Record<string, number>>((result, kind) => {
      result[kind] = (result[kind] ?? 0) + 1;
      return result;
    }, {});
    expect(Object.keys(counts).sort()).toEqual(["coal", "iron", "stone"]);
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1_150);
    }
  });

  it("preserves the byte-framed deterministic hash contract", () => {
    expect(hashPartsHex("alpha", 42, "é")).toBe(
      "aa51d421d9c18b86f4384ff0c3e67d562e1a12efd940fd2145e6192138f368f0"
    );
  });

  it("reuses a stable plan across non-authoritative provenance changes", () => {
    const identity = populationZoneV2PlanIdentity({
      zoneId: "ppz2-eag1/001/002",
      worldEnvironmentIdentityKey: WORLD_IDENTITY_A,
      environmentProfileVersion: "environment-profile-v1"
    });
    const firstCompilerProvenance = { identity, worldPipelineSha: "1".repeat(40) };
    const promotedCompilerProvenance = { identity, worldPipelineSha: "2".repeat(40) };
    expect(samePopulationZoneV2PlanAuthority(
      firstCompilerProvenance.identity,
      promotedCompilerProvenance.identity
    )).toBe(true);
    expect(populationZoneV2PlanId(firstCompilerProvenance.identity))
      .toBe(populationZoneV2PlanId(promotedCompilerProvenance.identity));
  });

  it("supersedes a plan when canonical authority identity changes", () => {
    const first = populationZoneV2PlanIdentity({
      zoneId: "ppz2-eag1/001/002",
      worldEnvironmentIdentityKey: WORLD_IDENTITY_A,
      environmentProfileVersion: "environment-profile-v1"
    });
    const next = populationZoneV2PlanIdentity({
      zoneId: "ppz2-eag1/001/002",
      worldEnvironmentIdentityKey: WORLD_IDENTITY_B,
      environmentProfileVersion: "environment-profile-v1"
    });
    expect(samePopulationZoneV2PlanAuthority(first, next)).toBe(false);
    expect(populationZoneV2PlanId(first)).not.toBe(populationZoneV2PlanId(next));
  });

  it("keeps expensive environment authority stable across recipe-only changes", () => {
    const current = populationZoneV2PlanIdentity({
      zoneId: "ppz2-eag1/001/002",
      worldEnvironmentIdentityKey: WORLD_IDENTITY_A,
      environmentProfileVersion: "environment-profile-v1"
    });
    const recipeOnlyChange = {
      ...current,
      populationPlanVersion: "population-zone-plan-compiler-v-next",
      spawnRulesVersion: "encounter-tables-v1"
    } as unknown as PopulationZoneV2PlanIdentity;

    expect(populationEnvironmentArtifactIdentity(recipeOnlyChange))
      .toEqual(populationEnvironmentArtifactIdentity(current));
    expect(populationGenerationRecipeIdentity(recipeOnlyChange))
      .not.toEqual(populationGenerationRecipeIdentity(current));
  });
});
