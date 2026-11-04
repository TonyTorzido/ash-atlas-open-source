import { describe, expect, it } from "vitest";

import {
  destinationPoint,
  POPULATION_BALANCE,
  POPULATION_DENSITY_REVISION,
  legacySapCrawlerGroupSizeForUnit
} from "@ash-atlas/shared";

import {
  greatCircleDistanceMeters,
  type PopulationZoneV2Id,
  populationZoneV2Geometry,
  populationZoneV2Halo,
  populationZoneV2IdForPoint,
  populationZoneV2Neighbors
} from "./populationZonesV2Geometry.js";
import {
  generateWorldEnvironmentCandidateSlots,
  type CandidateSlotPoint,
  type WorldEnvironmentCandidateSlot
} from "./gameplayEnvironmentProfiles.js";
import {
  deterministicEligibleAreaCount,
  deterministicPopulationZoneV2RareParentAllocation,
  estimatePopulationZoneV2Habitat,
  generatePopulationZoneV2GenerationSlots,
  generatePopulationZonesV2Plans,
  globalRankedPopulationZoneV2Candidates,
  incompleteSapCrawlerGroupCandidateIds,
  isPermanentMineEntityKind,
  materializeSapCrawlerTemplateGroups,
  populationPlacementCandidatesConflict,
  POPULATION_ZONE_V2_HABITAT_SAMPLE_COUNT,
  populationZoneV3ConservativeHabitat,
  type PopulationZoneV2Habitat,
  type PopulationZoneV2HabitatCandidateSite,
  type PopulationZoneV2HabitatFacts,
  type PopulationZoneV2HabitatWeights,
  type PopulationZoneV2PlanKind,
  type PopulationZoneV2PlanSlot,
  populationZoneV2RareParentHabitatZoneIds,
  populationZoneV2RareParentDomainForPoint,
  populationZoneV2EligibleAreaForKind,
  populationZoneV2HabitatSamplePoints,
  populationZoneV2GenerationId,
  reconcilePopulationZoneV2GenerationSlots,
  SAP_CRAWLER_DEER_MINIMUM_SPACING_M,
  SAP_CRAWLER_GROUP_MINIMUM_SPACING_M,
  SAP_CRAWLER_HOSTILE_MINIMUM_SPACING_M,
  SAP_CRAWLER_TREE_MINIMUM_SPACING_M,
  sapCrawlerGroupSiteSelection,
  stablePopulationZoneV2RareParentSlot
} from "./populationZonesV2Plan.js";
import {
  canonicalJson,
  deterministicUnit,
  deterministicUuidV8,
  permanentPopulationStoneIdentity,
  POPULATION_CANDIDATE_LAYOUT_VERSION,
  POPULATION_SPAWN_RULES_VERSION,
  POPULATION_STONE_PLACEMENT_VERSION,
  populationZoneV2AdvisoryLockKey,
  populationZoneV2PlanId,
  populationZoneV2PlanIdentity
} from "./populationZonesV2Identity.js";
import { ENVIRONMENT_PROFILE_VERSION } from "./gameplayEnvironmentProfileVersions.js";

const WORLD_IDENTITY = "9".repeat(64);
const WORLD_SHA = "a".repeat(40);

describe("population zones v2 plan identity", () => {
  it("uses the encounter-table spawn and candidate identities", () => {
    expect(POPULATION_SPAWN_RULES_VERSION)
      .toBe("population-spawn-rules-v4-uniform-tree-varieties");
    expect(POPULATION_CANDIDATE_LAYOUT_VERSION)
      .toBe("compact-owner-surface-origins-v5");
    expect(POPULATION_STONE_PLACEMENT_VERSION)
      .toBe("population-permanent-stone-placement-v1");
  });

  it("uses canonical UUIDv8 identities and stable signed lock keys", () => {
    const zoneId = populationZoneV2IdForPoint({ lat: 35.0844, lon: -106.6504 });
    const identity = populationZoneV2PlanIdentity({
      zoneId,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      environmentProfileVersion: "test-environment-v1"
    });
    const planId = populationZoneV2PlanId(identity);

    expect(planId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    );
    expect(populationZoneV2PlanId({ ...identity })).toBe(planId);
    expect(populationZoneV2AdvisoryLockKey(identity)).toBe(
      populationZoneV2AdvisoryLockKey({ ...identity })
    );
    expect(canonicalJson({ z: 1, a: [true, null] })).toBe(
      '{"a":[true,null],"z":1}'
    );
    expect(deterministicUuidV8("test", { b: 2, a: 1 })).toBe(
      deterministicUuidV8("test", { a: 1, b: 2 })
    );
  });
});

describe("population zones v2 production plan generation", () => {
  it("allocates Resin Crawlers from flat eligible land in every biome", () => {
    const domain = populationZoneV2RareParentDomainForPoint(
      "sap_crawler_group",
      { lat: 35.0844, lon: -106.6504 }
    );
    const outcomes = new Set<boolean>();
    for (const [biome, treeFraction] of [
      ["desert", 0],
      ["barren", 0.02],
      ["mountain", 0.1],
      ["grassland", 0.25],
      ["wetland", 0.6],
      ["ordinary", 1]
    ] as const) {
      const habitat: PopulationZoneV2Habitat = {
        regionCode: biome,
        eligibleLandKm2: domain.areaKm2,
        treeKm2: domain.areaKm2 * treeFraction,
        deerKm2: 0,
        wolfKm2: 0,
        stoneKm2: 0,
        ogreKm2: domain.areaKm2,
        habitatSummary: { biome },
        environmentSnapshot: { biome }
      };
      const eligibleArea = populationZoneV2EligibleAreaForKind(
        habitat,
        "sap_crawler_group"
      );
      expect(eligibleArea).toBe(habitat.eligibleLandKm2);
      if (treeFraction !== 1) {
        expect(eligibleArea).not.toBe(habitat.treeKm2);
      }
      outcomes.add(deterministicPopulationZoneV2RareParentAllocation(
        domain,
        eligibleArea,
        WORLD_IDENTITY
      ));
    }
    expect(outcomes).toEqual(new Set([true]));
  });

  it("preserves baseline candidates and ogres before deterministic expansion", () => {
    const origin = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const zoneIds = populationZoneV2Halo(origin, 6);
    const habitatForZone = (zoneId: PopulationZoneV2Id) =>
      populationZoneV3ConservativeHabitat({
        zoneId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY
      });
    const baseline = globalRankedPopulationZoneV2Candidates({
      outputZoneIds: zoneIds,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      baselineCommonDensity: true,
      habitatForZone
    });
    const expanded = globalRankedPopulationZoneV2Candidates({
      outputZoneIds: zoneIds,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      habitatForZone
    });
    const expandedById = new Map(expanded.map((candidate) => [
      candidate.candidateId,
      candidate
    ]));

    expect(POPULATION_DENSITY_REVISION)
      .toBe("population-land-encounter-density-v2");
    expect(baseline
      .filter((candidate) => candidate.kind !== "sap_crawler_group")
      .every((candidate) =>
      canonicalJson(expandedById.get(candidate.candidateId)!)
        === canonicalJson(candidate)
    )).toBe(true);
    expect(expanded.filter((candidate) => candidate.kind === "ogre"))
      .toEqual(baseline.filter((candidate) => candidate.kind === "ogre"));
    for (const kind of ["tree", "deer", "wolf_pack"] as const) {
      expect(expanded.filter((candidate) => candidate.kind === kind).length)
        .toBeGreaterThan(
          baseline.filter((candidate) => candidate.kind === kind).length
        );
    }
  });

  it("tops up exact common deficits without replacing ogres or partial packs", () => {
    const { desired } = generationWithAllPopulationKinds();
    const trees = desired.filter((slot) => slot.entityKind === "tree");
    const deer = desired.filter((slot) => slot.entityKind === "deer");
    const ogres = desired.filter((slot) => slot.entityKind === "ogre");
    const sapCrawlers = desired.filter((slot) =>
      slot.entityKind === "sap_crawler"
    );
    const wolfPacks = groupWolfPacks(desired);
    const retainedPacks = [...wolfPacks.values()]
      .slice(0, Math.floor(wolfPacks.size / 2));
    const existing = [
      ...trees.slice(0, Math.floor(trees.length / 2)),
      ...deer.slice(0, Math.floor(deer.length / 2)),
      ...retainedPacks.flat(),
      ...ogres,
      ...sapCrawlers
    ];
    const reconciled = reconcilePopulationZoneV2GenerationSlots({
      existingSlots: existing,
      desiredSlots: desired
    });
    const final = [...existing, ...reconciled.slotsToInsert];

    expect(reconciled.shortfallByKind).toEqual({
      tree: 0,
      flax: 0,
      deer: 0,
      wolf_pack: 0,
      sap_crawler_group: 0
    });
    expect(reconciled.plannedNonStoneCount).toBe(desired.length);
    expect(new Set(final.map((slot) => slot.entityId))).toEqual(
      new Set(desired.map((slot) => slot.entityId))
    );
    expect(new Set(final.map((slot) =>
      `${slot.position.lat}/${slot.position.lon}`
    )).size).toBe(final.length);
    expect(reconciled.slotsToInsert.some((slot) =>
      slot.entityKind === "ogre"
    )).toBe(false);
    expect(groupWolfPacks(final).size).toBe(wolfPacks.size);
    const partialPack = [...wolfPacks.values()][0]!;
    const partialExisting = final.filter((slot) =>
      slot.packId !== partialPack[0]!.packId
    ).concat(partialPack.slice(0, 1));
    const partialReplay = reconcilePopulationZoneV2GenerationSlots({
      existingSlots: partialExisting,
      desiredSlots: desired
    });
    expect(partialReplay.slotsToInsert).toEqual([]);
    expect(partialReplay.shortfallByKind.wolf_pack).toBe(0);
    expect(reconcilePopulationZoneV2GenerationSlots({
      existingSlots: final,
      desiredSlots: desired
    })).toEqual({
      slotsToInsert: [],
      plannedNonStoneCount: desired.length,
      partialSapCrawlerCandidateIds: [],
      shortfallByKind: {
        tree: 0,
        flax: 0,
        deer: 0,
        wolf_pack: 0,
        sap_crawler_group: 0
      }
    });
  });

  it("is order-independent and excludes runtime SHA from stable content", () => {
    const origin = populationZoneV2IdForPoint({
      lat: 29.9511,
      lon: -90.0715
    });
    const zoneIds = [origin, ...populationZoneV2Neighbors(origin).slice(0, 4)];
    const first = generatePopulationZonesV2Plans({
      outputZoneIds: zoneIds,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: fullHabitat
    });
    const reversed = generatePopulationZonesV2Plans({
      outputZoneIds: [...zoneIds].reverse(),
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: "b".repeat(40),
      habitatForZone: fullHabitat
    });
    const firstByZone = new Map(first.map((plan) => [plan.identity.zoneId, plan]));
    const reversedByZone = new Map(
      reversed.map((plan) => [plan.identity.zoneId, plan])
    );

    for (const zoneId of zoneIds) {
      const left = firstByZone.get(zoneId)!;
      const right = reversedByZone.get(zoneId)!;
      expect(right.planId).toBe(left.planId);
      expect(right.contentHash).toBe(left.contentHash);
      expect(right.slots).toEqual(left.slots);
      expect(right.worldPipelineSha).not.toBe(left.worldPipelineSha);
    }
    const slots = first.flatMap((plan) => plan.slots);
    expect(new Set(slots.map((slot) => slot.entityId)).size).toBe(slots.length);
    expect(conflictViolations(slots)).toEqual({
      treeTree: 0,
      deerDeer: 0,
      treeDeer: 0,
      sceneryHostile: 0,
      wolfPackAnchors: 0,
      otherHostileAnchors: 0,
      wolfMembers: 0,
      stoneTree: 0,
      stoneMob: 0
    });
  });

  it("replays one generation, rotates non-stone identities and positions, and leaves stones permanent", () => {
    const zoneId = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const template = generatePopulationZonesV2Plans({
      outputZoneIds: [zoneId],
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: (ownerId) => populationZoneV3ConservativeHabitat({
        zoneId: ownerId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY
      })
    })[0]!;
    const firstGenerationId = populationZoneV2GenerationId({
      identity: template.identity,
      generationNumber: 1
    });
    const secondGenerationId = populationZoneV2GenerationId({
      identity: template.identity,
      generationNumber: 2
    });
    const first = generatePopulationZoneV2GenerationSlots({
      template,
      generationId: firstGenerationId,
      generationNumber: 1
    });
    const replay = generatePopulationZoneV2GenerationSlots({
      template,
      generationId: firstGenerationId,
      generationNumber: 1
    });
    const second = generatePopulationZoneV2GenerationSlots({
      template,
      generationId: secondGenerationId,
      generationNumber: 2
    });

    expect(replay).toEqual(first);
    expect(first.slots.length).toBeGreaterThan(0);
    expect(first.slots.every((slot) =>
      !isPermanentMineEntityKind(slot.entityKind)
    )).toBe(true);
    expect(first.plannedNonStoneCount).toBeLessThanOrEqual(
      template.slots.filter((slot) =>
        !isPermanentMineEntityKind(slot.entityKind)
      ).length
    );
    expect(second.plannedNonStoneCount).toBeLessThanOrEqual(
      template.slots.filter((slot) =>
        !isPermanentMineEntityKind(slot.entityKind)
      ).length
    );
    expect(new Set(first.slots.map((slot) => slot.entityId))).not.toEqual(
      new Set(second.slots.map((slot) => slot.entityId))
    );
    expect(first.slots.map((slot) => slot.position)).not.toEqual(
      second.slots.map((slot) => slot.position)
    );
    const permanentMines = template.slots.filter((slot) =>
      isPermanentMineEntityKind(slot.entityKind)
    );
    expect(permanentMines.length).toBeGreaterThan(0);
    const firstWorld = [...first.slots, ...permanentMines];
    const secondWorld = [...second.slots, ...permanentMines];
    expect(firstWorld.filter((slot) =>
      isPermanentMineEntityKind(slot.entityKind)
    )
      .map(({ entityId, position }) => ({ entityId, position })))
      .toEqual(secondWorld.filter((slot) =>
        isPermanentMineEntityKind(slot.entityKind)
      )
        .map(({ entityId, position }) => ({ entityId, position })));
  });

  it("materializes exact immutable Resin Crawler blueprints for every group size", () => {
    for (const size of [5, 6, 7] as const) {
      const template = sapCrawlerTemplateGroup(size, `template-${size}`);
      const firstGeneration = materializeSapCrawlerTemplateGroups({
        templateSlots: template,
        generationId: deterministicUuidV8("sap-generation", {
          generation: 1,
          size
        }),
        generationNumber: 1
      });
      const replay = materializeSapCrawlerTemplateGroups({
        templateSlots: [...template].reverse(),
        generationId: deterministicUuidV8("sap-generation", {
          generation: 1,
          size
        }),
        generationNumber: 1
      });
      const secondGeneration = materializeSapCrawlerTemplateGroups({
        templateSlots: template,
        generationId: deterministicUuidV8("sap-generation", {
          generation: 2,
          size
        }),
        generationNumber: 2
      });
      const byMember = (slots: readonly PopulationZoneV2PlanSlot[]) =>
        [...slots].sort((left, right) =>
          left.packMemberIndex! - right.packMemberIndex!
        );

      expect(firstGeneration).toHaveLength(size);
      expect(replay).toEqual(firstGeneration);
      expect(byMember(firstGeneration).map((slot) => slot.position))
        .toEqual(template.map((slot) => slot.position));
      expect(byMember(firstGeneration).map((slot) => slot.anchor))
        .toEqual(template.map((slot) => slot.anchor));
      expect(new Set(firstGeneration.map((slot) => slot.entityId)))
        .not.toEqual(new Set(secondGeneration.map((slot) => slot.entityId)));
      expect(new Set(firstGeneration.map((slot) => slot.slotId)))
        .not.toEqual(new Set(secondGeneration.map((slot) => slot.slotId)));
      expect(firstGeneration[0]!.packId).not.toBe(secondGeneration[0]!.packId);
      expect(firstGeneration[0]!.encounterId)
        .not.toBe(secondGeneration[0]!.encounterId);
    }
  });

  it("reconciles complete Resin Crawler groups atomically and rejects partial packs", () => {
    const desired = [
      ...sapCrawlerTemplateGroup(5, "group-a"),
      ...sapCrawlerTemplateGroup(5, "group-b", 0.01),
      ...sapCrawlerTemplateGroup(5, "group-c", 0.02)
    ];
    const empty = reconcilePopulationZoneV2GenerationSlots({
      existingSlots: [],
      desiredSlots: desired
    });
    expect(empty.slotsToInsert).toHaveLength(15);
    expect(empty.plannedNonStoneCount).toBe(15);
    expect(empty.shortfallByKind.sap_crawler_group).toBe(0);
    expect(empty.partialSapCrawlerCandidateIds).toEqual([]);
    expect(reconcilePopulationZoneV2GenerationSlots({
      existingSlots: empty.slotsToInsert,
      desiredSlots: desired
    })).toMatchObject({
      slotsToInsert: [],
      plannedNonStoneCount: 15,
      partialSapCrawlerCandidateIds: [],
      shortfallByKind: { sap_crawler_group: 0 }
    });

    const partial = desired.slice(0, 2);
    const corrupt = reconcilePopulationZoneV2GenerationSlots({
      existingSlots: partial,
      desiredSlots: desired.slice(0, 5)
    });
    expect(incompleteSapCrawlerGroupCandidateIds(partial)).toEqual(["group-a"]);
    expect(corrupt.slotsToInsert).toEqual([]);
    expect(corrupt.partialSapCrawlerCandidateIds).toEqual(["group-a"]);
    expect(corrupt.shortfallByKind.sap_crawler_group).toBe(1);
  });

  it("meets large-area density, Ogre ratio, and group-size distribution targets", () => {
    const areaKm2 = 4_096;
    const sapGroups = deterministicEligibleAreaCount({
      ownerId: "fully-eligible-inland",
      kind: "sap_crawler_group",
      eligibleAreaKm2: areaKm2,
      densityPerEligibleKm2:
        1 / POPULATION_BALANCE.rare.sap_crawler_group.targetAreaKm2,
      worldEnvironmentIdentityKey: WORLD_IDENTITY
    });
    const ogres = deterministicEligibleAreaCount({
      ownerId: "fully-eligible-inland",
      kind: "ogre",
      eligibleAreaKm2: areaKm2,
      densityPerEligibleKm2:
        1 / POPULATION_BALANCE.rare.ogre.targetAreaKm2,
      worldEnvironmentIdentityKey: WORLD_IDENTITY
    });
    expect(sapGroups / areaKm2).toBeCloseTo(0.125, 6);
    expect(ogres / sapGroups).toBeGreaterThanOrEqual(1.9);
    expect(ogres / sapGroups).toBeLessThanOrEqual(2.1);

    const sizes = { 5: 0, 6: 0, 7: 0 };
    for (let index = 0; index < 10_000; index += 1) {
      const size = legacySapCrawlerGroupSizeForUnit(deterministicUnit(
        "population-sap-crawler-group-size-v1",
        `large-area-sap-group-${index}`
      ));
      sizes[size] += 1;
    }
    expect(sizes[5] / 10_000).toBeGreaterThan(0.28);
    expect(sizes[5] / 10_000).toBeLessThan(0.32);
    expect(sizes[6] / 10_000).toBeGreaterThan(0.48);
    expect(sizes[6] / 10_000).toBeLessThan(0.52);
    expect(sizes[7] / 10_000).toBeGreaterThan(0.18);
    expect(sizes[7] / 10_000).toBeLessThan(0.22);
  });

  it("plans and materializes the 223 km2 live-shaped group target", () => {
    const areaKm2 = 223;
    const groupCount = deterministicEligibleAreaCount({
      ownerId: "launch-6-live-shaped",
      kind: "sap_crawler_group",
      eligibleAreaKm2: areaKm2,
      densityPerEligibleKm2:
        1 / POPULATION_BALANCE.rare.sap_crawler_group.targetAreaKm2,
      worldEnvironmentIdentityKey: WORLD_IDENTITY
    });
    const template = Array.from({ length: groupCount }, (_, index) => {
      const candidateId = `live-shaped-sap-${index}`;
      const size = legacySapCrawlerGroupSizeForUnit(deterministicUnit(
        "population-sap-crawler-group-size-v1",
        candidateId
      ));
      return sapCrawlerTemplateGroup(size, candidateId, index * 0.01);
    }).flat();
    const generated = materializeSapCrawlerTemplateGroups({
      templateSlots: template,
      generationId: deterministicUuidV8("live-shaped-generation", {
        areaKm2
      }),
      generationNumber: 1
    });
    expect(groupCount).toBe(28);
    expect(new Set(generated.map((slot) => slot.packId)).size).toBe(groupCount);
    expect(generated).toHaveLength(template.length);
  });

  it("keeps permanent stone identity independent of non-stone plan policy", () => {
    const zoneId = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const template = generatePopulationZonesV2Plans({
      outputZoneIds: [zoneId],
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: (ownerId) => populationZoneV3ConservativeHabitat({
        zoneId: ownerId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY
      })
    })[0]!;
    const mine = template.slots.find((slot) =>
      isPermanentMineEntityKind(slot.entityKind)
    );
    expect(mine).toBeDefined();
    const nonStone = template.slots.find((slot) =>
      !isPermanentMineEntityKind(slot.entityKind)
    );
    expect(nonStone).toBeDefined();
    expect(mine!.environmentSnapshot.candidateSite)
      .not.toHaveProperty("surfaceType");
    expect(mine!.environmentSnapshot.candidateSite)
      .not.toHaveProperty("surfaceAuthority");
    expect(nonStone!.environmentSnapshot.candidateSite)
      .toHaveProperty("surfaceType");
    expect(nonStone!.environmentSnapshot.candidateSite)
      .toHaveProperty("surfaceAuthority");
    const original = permanentPopulationStoneIdentity({
      identity: template.identity,
      candidateId: mine!.candidateId,
      ownerZoneId: zoneId
    });
    const lifecycleOnlyChange = permanentPopulationStoneIdentity({
      identity: {
        ...template.identity,
        respawnPolicyVersion: "population-generation-96h-v2" as never
      },
      candidateId: mine!.candidateId,
      ownerZoneId: zoneId
    });

    expect(original).toEqual(lifecycleOnlyChange);
    expect(original).toEqual({
      slotId: mine!.slotId,
      entityId: mine!.entityId
    });
  });

  it("resolves adjacent generations symmetrically with their own identities", () => {
    const firstZoneId = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const secondZoneId = populationZoneV2Neighbors(firstZoneId)[0]!;
    const templates = generatePopulationZonesV2Plans({
      outputZoneIds: [firstZoneId, secondZoneId],
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: fullHabitat
    });
    const byZone = new Map(templates.map((plan) => [
      plan.identity.zoneId,
      plan
    ]));
    const firstTemplate = byZone.get(firstZoneId)!;
    const secondTemplate = byZone.get(secondZoneId)!;
    const firstGenerationId = populationZoneV2GenerationId({
      identity: firstTemplate.identity,
      generationNumber: 1
    });
    const secondGenerationId = populationZoneV2GenerationId({
      identity: secondTemplate.identity,
      generationNumber: 1
    });
    expect(secondGenerationId).not.toBe(firstGenerationId);
    const habitats = new Map(templates.map((plan) => [
      plan.identity.zoneId as PopulationZoneV2Id,
      plan.habitat
    ]));
    const generateFirst = () => generatePopulationZoneV2GenerationSlots({
      template: firstTemplate,
      generationId: firstGenerationId,
      generationNumber: 1,
      neighborGenerationIdsByZone: {
        [secondZoneId]: [secondGenerationId]
      },
      neighborHabitatsByZone: habitats
    });
    const generateSecond = () => generatePopulationZoneV2GenerationSlots({
      template: secondTemplate,
      generationId: secondGenerationId,
      generationNumber: 1,
      neighborGenerationIdsByZone: {
        [firstZoneId]: [firstGenerationId]
      },
      neighborHabitatsByZone: habitats
    });

    const firstThenSecond = [generateFirst(), generateSecond()];
    const secondThenFirst = [generateSecond(), generateFirst()];
    expect(secondThenFirst[1]).toEqual(firstThenSecond[0]);
    expect(secondThenFirst[0]).toEqual(firstThenSecond[1]);

    const combined = [
      ...firstThenSecond.flatMap((generation) => generation.slots),
      ...templates.flatMap((template) =>
        template.slots.filter((slot) => slot.entityKind === "stone")
      )
    ];
    expect(conflictViolations(combined)).toEqual({
      treeTree: 0,
      deerDeer: 0,
      treeDeer: 0,
      sceneryHostile: 0,
      wolfPackAnchors: 0,
      otherHostileAnchors: 0,
      wolfMembers: 0,
      stoneTree: 0,
      stoneMob: 0
    });
  });

  it("places water-heavy population only on screened owner candidate slots", async () => {
    const zoneId = populationZoneV2IdForPoint({
      lat: 29.9511,
      lon: -90.0715
    });
    const geometry = populationZoneV2Geometry(zoneId);
    const profileSlots = waterHeavyCandidateSlots(geometry);
    const estimate = await estimatePopulationZoneV2Habitat({
      zoneId,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      regionCode: "water-heavy-fixture",
      factsForPoint: (sample) => waterHeavyProfileFacts(
        geometry,
        sample.position,
        profileSlots
      )
    });
    expect(estimate.status).toBe("ready");
    expect(estimate.habitat.eligibleLandKm2 / geometry.areaKm2)
      .toBeGreaterThan(0.2);
    expect(estimate.habitat.eligibleLandKm2 / geometry.areaKm2)
      .toBeLessThan(0.6);
    expect(estimate.habitat.candidateSites?.length).toBeGreaterThan(0);
    expect(estimate.habitat.candidateSites?.length)
      .toBeLessThanOrEqual(profileSlots.length);
    expect(estimate.habitat.candidateSites?.every((site) =>
      site.source === "world-profile-candidate-slot"
      && populationZoneV2IdForPoint(site.position) === zoneId
    )).toBe(true);

    const plan = generatePopulationZonesV2Plans({
      outputZoneIds: [zoneId],
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: (ownerId) => ownerId === zoneId
        ? estimate.habitat
        : zeroHabitat(ownerId)
    })[0]!;
    expect(plan.slots.length).toBeGreaterThan(0);
    const sites = new Map(
      estimate.habitat.candidateSites?.map((site) => [site.siteId, site])
    );
    for (const slot of plan.slots) {
      const provenance = slot.environmentSnapshot.candidateSite as Readonly<{
        siteId: string;
      }>;
      const site = sites.get(provenance.siteId);
      expect(site, slot.entityId).toBeDefined();
      expect(site?.position).toEqual(slot.position);
      expect(habitatSiteWeightForEntity(site!, slot.entityKind))
        .toBeGreaterThan(0);
      expect(waterHeavyLandAt(geometry, slot.position)).toBe(true);
    }
  });

  it("selects an eligible rare parent site after one parent-area allocation", async () => {
    const origin = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    let selected: Readonly<{
      zoneId: PopulationZoneV2Id;
      habitat: PopulationZoneV2Habitat;
      candidate: ReturnType<
        typeof globalRankedPopulationZoneV2Candidates
      >[number];
    }> | null = null;
    for (const zoneId of populationZoneV2Halo(origin, 5)) {
      const estimate = await estimatePopulationZoneV2Habitat({
        zoneId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY,
        regionCode: "rare-fixture",
        factsForPoint: () => landFacts("temperate-forest")
      });
      const habitat = rareOnlyHabitat(estimate.habitat);
      const candidate = globalRankedPopulationZoneV2Candidates({
        outputZoneIds: [zoneId],
        worldEnvironmentIdentityKey: WORLD_IDENTITY,
        habitatForZone: (ownerId) => ownerId === zoneId
          ? habitat
          : zeroHabitat(ownerId)
      }).find((entry) => entry.kind === "stone" || entry.kind === "ogre");
      if (candidate) {
        selected = { zoneId, habitat, candidate };
        break;
      }
    }
    expect(selected).not.toBeNull();
    const rare = selected!.candidate;
    const kind = rare.kind as "stone" | "ogre";
    const domainId = populationZoneV2RareParentDomainForPoint(
      kind,
      rare.anchorSite.position
    ).id;
    expect(selected!.habitat.candidateSites?.some((site) =>
      site.siteId !== rare.anchorSite.siteId
      && populationZoneV2RareParentDomainForPoint(kind, site.position).id
        === domainId
      && habitatSiteWeightForPlanKind(site, kind) > 0
    )).toBe(true);
    const withSelectedSiteUnderWater: PopulationZoneV2Habitat = {
      ...selected!.habitat,
      candidateSites: selected!.habitat.candidateSites!.map((site) =>
        site.siteId === rare.anchorSite.siteId
          ? {
              ...site,
              isSaltwater: true,
              weights: {
                ...site.weights,
                eligibleLand: 0,
                [kind]: 0
              }
            }
          : site
      )
    };
    const after = globalRankedPopulationZoneV2Candidates({
      outputZoneIds: [selected!.zoneId],
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      habitatForZone: (ownerId) => ownerId === selected!.zoneId
        ? withSelectedSiteUnderWater
        : zeroHabitat(ownerId)
    });
    const relocated = after.find((candidate) =>
      candidate.candidateId === rare.candidateId
    );
    expect(relocated).toBeDefined();
    expect(relocated!.anchorSite.siteId).not.toBe(rare.anchorSite.siteId);
    expect(habitatSiteWeightForPlanKind(relocated!.anchorSite, kind))
      .toBeGreaterThan(0);

    const geometry = populationZoneV2Geometry(selected!.zoneId);
    const tinyEligibleArea = geometry.areaKm2 * 1e-9;
    const withTinyPositiveEligibleArea: PopulationZoneV2Habitat = {
      ...selected!.habitat,
      stoneKm2: kind === "stone" ? tinyEligibleArea : 0,
      ogreKm2: kind === "ogre" ? tinyEligibleArea : 0
    };
    const tinyFirst = globalRankedPopulationZoneV2Candidates({
      outputZoneIds: [selected!.zoneId],
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      habitatForZone: (ownerId) => ownerId === selected!.zoneId
        ? withTinyPositiveEligibleArea
        : zeroHabitat(ownerId)
    });
    const tinySecond = globalRankedPopulationZoneV2Candidates({
      outputZoneIds: [selected!.zoneId],
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      habitatForZone: (ownerId) => ownerId === selected!.zoneId
        ? withTinyPositiveEligibleArea
        : zeroHabitat(ownerId)
    });
    expect(tinySecond.map((candidate) => candidate.candidateId))
      .toEqual(tinyFirst.map((candidate) => candidate.candidateId));
    expect(tinyFirst.some((candidate) =>
      candidate.candidateId === rare.candidateId
    )).toBe(false);
  });

  it("allocates a mixed coastal parent domain from aggregate eligible area", async () => {
    const domain = populationZoneV2RareParentDomainForPoint(
      "stone",
      { lat: 29.2, lon: -89.3 }
    );
    const coastLongitude =
      (domain.bounds.westLon + domain.bounds.eastLon) / 2;
    let identity = "";
    for (let value = 1; value < 4_096; value += 1) {
      const candidate = value.toString(16).padStart(64, "0");
      const stableSlot = stablePopulationZoneV2RareParentSlot(
        domain,
        candidate
      );
      const allocationUnit = deterministicUnit(
        "population-rare-eligible-area-selection-v1",
        candidate,
        ENVIRONMENT_PROFILE_VERSION,
        domain.id
      );
      if (
        stableSlot.position.lon >= coastLongitude
        && allocationUnit < 0.2
      ) {
        identity = candidate;
        break;
      }
    }
    expect(identity).not.toBe("");

    const domainZoneIds =
      populationZoneV2RareParentHabitatZoneIds(domain);
    const habitats = new Map<PopulationZoneV2Id, PopulationZoneV2Habitat>();
    await Promise.all(domainZoneIds.map(async (zoneId) => {
      const estimate = await estimatePopulationZoneV2Habitat({
        zoneId,
        worldEnvironmentIdentityKey: identity,
        regionCode: "mixed-coastal-parent",
        factsForPoint: (sample) => sample.position.lon < coastLongitude
          ? landFacts("rocky-coast")
          : waterFacts()
      });
      habitats.set(zoneId, stoneOnlyHabitat(estimate.habitat));
    }));
    const aggregateFraction = [...habitats.entries()].reduce(
      (sum, [zoneId, habitat]) =>
        sum + habitat.stoneKm2 / populationZoneV2Geometry(zoneId).areaKm2,
      0
    ) / habitats.size;
    expect(aggregateFraction).toBeGreaterThan(0.35);
    expect(aggregateFraction).toBeLessThan(0.65);

    const candidates = globalRankedPopulationZoneV2Candidates({
      outputZoneIds: domainZoneIds,
      worldEnvironmentIdentityKey: identity,
      habitatForZone: (zoneId) =>
        habitats.get(zoneId) ?? zeroHabitat(zoneId)
    });
    const selected = candidates.find((candidate) =>
      candidate.candidateId.startsWith(`${domain.id}/`)
    );
    expect(stablePopulationZoneV2RareParentSlot(domain, identity).position.lon)
      .toBeGreaterThanOrEqual(coastLongitude);
    expect(selected).toMatchObject({ kind: "stone" });
    expect(selected!.position.lon).toBeLessThan(coastLongitude);
    expect(habitatSiteWeightForPlanKind(selected!.anchorSite, "stone"))
      .toBeGreaterThan(0);
  });

  it("omits incomplete wolf clusters and emits only screened member slots", () => {
    const zoneId = populationZoneV2IdForPoint({
      lat: 42.3601,
      lon: -71.0589
    });
    const geometry = populationZoneV2Geometry(zoneId);
    const cluster = firstOwnerLocalCandidateCluster(geometry);
    const anchor = cluster.find((point) =>
      point.placementTags.includes("cluster-anchor")
    )!;
    const members = cluster.filter((point) =>
      point.placementTags.includes("cluster-member")
    );
    expect(members).toHaveLength(6);
    const wolfKm2 = geometry.areaKm2 * 0.3;
    const worldEnvironmentIdentityKey = identityWithOneWolfCandidate(
      zoneId,
      wolfKm2
    );
    const partialSites = cluster.map((point) =>
      testCandidateSite(
        point,
        point.slotId === anchor.slotId
          || members.slice(0, 2).some((member) => member.slotId === point.slotId)
      )
    );
    const partialHabitat = habitatWithCandidateSites(
      zoneId,
      partialSites,
      wolfKm2
    );
    const partialPlan = generatePopulationZonesV2Plans({
      outputZoneIds: [zoneId],
      worldEnvironmentIdentityKey,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: (ownerId) => ownerId === zoneId
        ? partialHabitat
        : zeroHabitat(ownerId)
    })[0]!;
    expect(partialPlan.slots.filter((slot) => slot.entityKind === "wolf"))
      .toEqual([]);

    const completeSites = cluster.map((point) =>
      testCandidateSite(point, true)
    );
    const completeHabitat = habitatWithCandidateSites(
      zoneId,
      completeSites,
      wolfKm2
    );
    const completePlan = generatePopulationZonesV2Plans({
      outputZoneIds: [zoneId],
      worldEnvironmentIdentityKey,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: (ownerId) => ownerId === zoneId
        ? completeHabitat
        : zeroHabitat(ownerId)
    })[0]!;
    const wolves = completePlan.slots.filter((slot) =>
      slot.entityKind === "wolf"
    );
    expect([2, 3, 4]).toContain(wolves.length);
    const siteById = new Map(completeSites.map((site) => [site.siteId, site]));
    for (const wolf of wolves) {
      const provenance = wolf.environmentSnapshot.candidateSite as Readonly<{
        siteId: string;
      }>;
      const site = siteById.get(provenance.siteId);
      expect(site?.position).toEqual(wolf.position);
      expect(site?.weights.wolf).toBeGreaterThan(0);
    }
  });

  it("counts deterministic wolf packs once before atomic 2/3-member expansion", () => {
    const origin = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const zoneIds = populationZoneV2Halo(origin, 10);
    const plans = generatePopulationZonesV2Plans({
      outputZoneIds: zoneIds,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: (zoneId) => populationZoneV3ConservativeHabitat({
        zoneId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY
      })
    });
    const slots = plans.flatMap((plan) => plan.slots);
    const wolves = slots.filter((slot) => slot.entityKind === "wolf");
    const packs = new Map<string, PopulationZoneV2PlanSlot[]>();
    for (const wolf of wolves) {
      const members = packs.get(wolf.packId!) ?? [];
      members.push(wolf);
      packs.set(wolf.packId!, members);
    }
    const sizes = [...packs.values()].map((members) => members.length);

    expect(packs.size).toBeGreaterThan(0);
    expect(new Set(sizes)).toEqual(new Set([2, 3]));
    expect(sizes.reduce((total, size) => total + size, 0) / sizes.length)
      .toBeGreaterThan(2.7);
    expect(sizes.reduce((total, size) => total + size, 0) / sizes.length)
      .toBeLessThanOrEqual(3);
    for (const members of packs.values()) {
      expect(new Set(members.map((member) => member.encounterId)).size).toBe(1);
      expect(new Set(members.map((member) => member.packId)).size).toBe(1);
      expect(members.map((member) => member.packMemberIndex).sort())
        .toEqual([...members.keys()]);
    }
    expect(slots.some((slot) => slot.entityKind === "stone")).toBe(true);
    expect(slots.some((slot) => slot.entityKind === "ogre")).toBe(true);
    expect(conflictViolations(slots)).toEqual({
      treeTree: 0,
      deerDeer: 0,
      treeDeer: 0,
      sceneryHostile: 0,
      wolfPackAnchors: 0,
      otherHostileAnchors: 0,
      wolfMembers: 0,
      stoneTree: 0,
      stoneMob: 0
    });
  });

  it("keeps allocated Resin Crawler groups ahead of common expansion with production-shaped clusters", () => {
    const zoneId = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const profileZoneIds = populationZoneV2Halo(zoneId, 7);
    const sitesByOwner = new Map<
      PopulationZoneV2Id,
      PopulationZoneV2HabitatCandidateSite[]
    >();
    for (const profileZoneId of profileZoneIds) {
      const points = generateWorldEnvironmentCandidateSlots({
        cellId: `sap-production-shaped-${profileZoneId}`,
        candidateSlotVersion: "gameplay-environment-candidates-v1",
        center: populationZoneV2Geometry(profileZoneId).center
      });
      for (const point of points) {
        const site = sapCrawlerCandidateSite(point);
        const ownerId = populationZoneV2IdForPoint(point.position);
        const ownerSites = sitesByOwner.get(ownerId) ?? [];
        ownerSites.push({
          ...site,
          siteId: `${profileZoneId}/${site.siteId}`,
          source: "world-profile-candidate-slot",
          sourceCellId: `sap-production-shaped-${profileZoneId}`,
          weights: {
            ...site.weights,
            deer: 1,
            wolf: 1
          }
        });
        sitesByOwner.set(ownerId, ownerSites);
      }
    }
    const outputZoneIds = [...sitesByOwner.keys()].sort();
    const plans = generatePopulationZonesV2Plans({
      outputZoneIds,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: (ownerId) => ({
        ...fullHabitat(ownerId),
        candidateSites: sitesByOwner.get(ownerId) ?? [],
        habitatSummary: {
          fixture: "16 anchor-plus-six clusters at 47 m per profile"
        }
      })
    });
    const diagnostics = plans.reduce(
      (total, plan) => ({
        allocatedCandidates:
          total.allocatedCandidates
            + plan.sapCrawlerDiagnostics!.allocatedCandidates,
        noEligibleClusterCandidates:
          total.noEligibleClusterCandidates
            + plan.sapCrawlerDiagnostics!.noEligibleClusterCandidates,
        insufficientValidSiteCandidates:
          total.insufficientValidSiteCandidates
            + plan.sapCrawlerDiagnostics!.insufficientValidSiteCandidates,
        conflictRejectedCandidates:
          total.conflictRejectedCandidates
            + plan.sapCrawlerDiagnostics!.conflictRejectedCandidates,
        finalPlannedGroups:
          total.finalPlannedGroups
            + plan.sapCrawlerDiagnostics!.finalPlannedGroups
      }),
      {
        allocatedCandidates: 0,
        noEligibleClusterCandidates: 0,
        insufficientValidSiteCandidates: 0,
        conflictRejectedCandidates: 0,
        finalPlannedGroups: 0
      }
    );

    expect([...sitesByOwner.values()].flat()).toHaveLength(
      profileZoneIds.length * 112
    );
    expect(diagnostics.allocatedCandidates).toBeGreaterThan(0);
    expect(
      diagnostics.noEligibleClusterCandidates
        + diagnostics.insufficientValidSiteCandidates
        + diagnostics.conflictRejectedCandidates
        + diagnostics.finalPlannedGroups
    ).toBe(diagnostics.allocatedCandidates);
    expect(
      diagnostics.finalPlannedGroups / diagnostics.allocatedCandidates,
      JSON.stringify(diagnostics)
    ).toBeGreaterThanOrEqual(0.95);
  });

  it("materializes one deterministic Resin Crawler candidate as 5-7 whole members", () => {
    const zoneId = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const geometry = populationZoneV2Geometry(zoneId);
    const cluster = firstOwnerLocalSapCrawlerCluster(geometry);
    const candidateSites = cluster.map(sapCrawlerCandidateSite);
    const habitat: PopulationZoneV2Habitat = {
      regionCode: "sap-crawler-fixture",
      eligibleLandKm2: geometry.areaKm2,
      treeKm2: geometry.areaKm2,
      deerKm2: 0,
      wolfKm2: 0,
      stoneKm2: 0,
      ogreKm2: 0,
      habitatSummary: { fixture: "sap-crawler-cluster" },
      environmentSnapshot: { fixture: "sap-crawler-cluster" },
      candidateSites
    };
    const generate = (
      worldPipelineSha: string,
      sites = candidateSites
    ) =>
      generatePopulationZonesV2Plans({
        outputZoneIds: [zoneId],
        worldEnvironmentIdentityKey: WORLD_IDENTITY,
        worldPipelineSha,
        habitatForZone: (ownerId) => ownerId === zoneId
          ? { ...habitat, candidateSites: sites }
          : {
              ...zeroHabitat(ownerId),
              eligibleLandKm2: populationZoneV2Geometry(ownerId).areaKm2,
              treeKm2: populationZoneV2Geometry(ownerId).areaKm2
            }
      })[0]!;
    const template = generate(WORLD_SHA);
    const replay = generate("b".repeat(40));
    const reordered = generate(WORLD_SHA, [...candidateSites].reverse());
    const crawlers = template.slots.filter((slot) =>
      slot.entityKind === "sap_crawler"
    );
    expect(replay.contentHash).toBe(template.contentHash);
    expect(reordered.slots).toEqual(template.slots);
    expect(crawlers.length).toBeGreaterThanOrEqual(5);
    expect(crawlers.length).toBeLessThanOrEqual(7);
    expect(new Set(crawlers.map((slot) => slot.candidateId)).size).toBe(1);
    expect(new Set(crawlers.map((slot) => slot.encounterId)).size).toBe(1);
    expect(new Set(crawlers.map((slot) => slot.packId)).size).toBe(1);
    expect(new Set(crawlers.map((slot) => slot.slotId)).size).toBe(crawlers.length);
    expect(new Set(crawlers.map((slot) => slot.entityId)).size).toBe(crawlers.length);
    expect(new Set(crawlers.map((slot) =>
      `${slot.position.lat}/${slot.position.lon}`
    )).size).toBe(crawlers.length);
    expect(crawlers.map((slot) => slot.packMemberIndex).sort())
      .toEqual([...crawlers.keys()]);
    expect(crawlers.every((slot) =>
      slot.anchor.lat === crawlers[0]!.anchor.lat
      && slot.anchor.lon === crawlers[0]!.anchor.lon
      && slot.environmentSnapshot.candidateSite !== undefined
    )).toBe(true);
    expect(template.sapCrawlerDiagnostics).toMatchObject({
      finalPlannedGroups: 1,
      finalPlannedMembers: crawlers.length,
      placementShortfallGroups:
        template.sapCrawlerDiagnostics!.allocatedCandidates - 1
    });
    expect(
      template.sapCrawlerDiagnostics!.noEligibleClusterCandidates
      + template.sapCrawlerDiagnostics!.insufficientValidSiteCandidates
      + template.sapCrawlerDiagnostics!.conflictRejectedCandidates
    ).toBe(template.sapCrawlerDiagnostics!.placementShortfallGroups);

    const firstGenerationId = populationZoneV2GenerationId({
      identity: template.identity,
      generationNumber: 1
    });
    const secondGenerationId = populationZoneV2GenerationId({
      identity: template.identity,
      generationNumber: 2
    });
    const domain = populationZoneV2RareParentDomainForPoint(
      "sap_crawler_group",
      candidateSites[0]!.position
    );
    const neighborHabitats = new Map(
      populationZoneV2RareParentHabitatZoneIds(domain)
        .filter((ownerId) => ownerId !== zoneId)
        .map((ownerId) => {
          const areaKm2 = populationZoneV2Geometry(ownerId).areaKm2;
          return [ownerId, {
            ...zeroHabitat(ownerId),
            eligibleLandKm2: areaKm2,
            treeKm2: areaKm2
          }] as const;
        })
    );
    const firstGeneration = generatePopulationZoneV2GenerationSlots({
      template,
      generationId: firstGenerationId,
      generationNumber: 1,
      neighborHabitatsByZone: neighborHabitats
    });
    const secondGeneration = generatePopulationZoneV2GenerationSlots({
      template,
      generationId: secondGenerationId,
      generationNumber: 2,
      neighborHabitatsByZone: neighborHabitats
    });
    const firstIds = firstGeneration.slots
      .filter((slot) => slot.entityKind === "sap_crawler")
      .map((slot) => slot.entityId);
    const secondIds = secondGeneration.slots
      .filter((slot) => slot.entityKind === "sap_crawler")
      .map((slot) => slot.entityId);
    const orderedSapPositions = (slots: readonly PopulationZoneV2PlanSlot[]) =>
      slots.filter((slot) => slot.entityKind === "sap_crawler")
        .sort((left, right) =>
          left.packMemberIndex! - right.packMemberIndex!
        )
        .map((slot) => slot.position);
    expect(firstIds.length).toBe(crawlers.length);
    expect(secondIds.length).toBe(crawlers.length);
    expect(orderedSapPositions(firstGeneration.slots))
      .toEqual(orderedSapPositions(crawlers));
    expect(orderedSapPositions(secondGeneration.slots))
      .toEqual(orderedSapPositions(crawlers));
    expect(new Set(firstIds)).not.toEqual(new Set(secondIds));
    expect(firstGeneration.plannedNonStoneCount)
      .toBe(firstGeneration.slots.length);
  });

  it("validates Resin Crawler clusters against the deterministic member count", () => {
    const zoneId = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const cluster = firstOwnerLocalSapCrawlerCluster(
      populationZoneV2Geometry(zoneId)
    ).map(sapCrawlerCandidateSite);
    const domain = populationZoneV2RareParentDomainForPoint(
      "sap_crawler_group",
      cluster[0]!.position
    );

    for (const memberCount of [5, 6, 7] as const) {
      const candidateId = candidateIdForSapCrawlerSize(memberCount);
      const exact = sapCrawlerGroupSiteSelection({
        candidateId,
        domain,
        ownerId: zoneId,
        candidateSites: cluster.slice(0, memberCount)
      });
      expect(exact.memberCount).toBe(memberCount);
      expect(exact.alternatives).toHaveLength(1);
      expect(exact.alternatives[0]).toHaveLength(memberCount);
      expect(new Set(exact.alternatives[0]!.map((site) =>
        `${site.position.lat}/${site.position.lon}`
      )).size).toBe(memberCount);
      expect(sapCrawlerGroupSiteSelection({
        candidateId,
        domain,
        ownerId: zoneId,
        candidateSites: [...cluster.slice(0, memberCount)].reverse()
      }).alternatives).toEqual(exact.alternatives);
    }

    const sevenId = candidateIdForSapCrawlerSize(7);
    const insufficient = sapCrawlerGroupSiteSelection({
      candidateId: sevenId,
      domain,
      ownerId: zoneId,
      candidateSites: cluster.slice(0, 6)
    });
    expect(insufficient.memberCount).toBe(7);
    expect(insufficient.eligibleClusterCount).toBe(1);
    expect(insufficient.maximumValidSiteCount).toBe(6);
    expect(insufficient.alternatives).toEqual([]);

    const fiveId = candidateIdForSapCrawlerSize(5);
    const lowTreeLand = cluster.slice(0, 5).map((site) => ({
      ...site,
      weights: { ...site.weights, tree: 0 }
    }));
    expect(sapCrawlerGroupSiteSelection({
      candidateId: fiveId,
      domain,
      ownerId: zoneId,
      candidateSites: lowTreeLand
    }).alternatives).toHaveLength(1);
    const water = lowTreeLand.map((site, index) => index === 4
      ? { ...site, isSaltwater: true }
      : site);
    expect(sapCrawlerGroupSiteSelection({
      candidateId: fiveId,
      domain,
      ownerId: zoneId,
      candidateSites: water
    }).alternatives).toEqual([]);
    const lake = lowTreeLand.map((site, index) => index === 4
      ? { ...site, insideMajorLake: true }
      : site);
    expect(sapCrawlerGroupSiteSelection({
      candidateId: fiveId,
      domain,
      ownerId: zoneId,
      candidateSites: lake
    }).alternatives).toEqual([]);
  });
});

describe("Resin Crawler placement conflicts", () => {
  const origin = { lat: 35.0844, lon: -106.6504 };
  const placement = (
    kind: PopulationZoneV2PlanKind,
    distanceM: number,
    homes?: readonly { lat: number; lon: number }[]
  ) => {
    const position = distanceM === 0
      ? origin
      : destinationPoint(origin, distanceM, 90);
    return { kind, position, homes: homes ?? [position] };
  };
  const expectSymmetric = (
    left: ReturnType<typeof placement>,
    right: ReturnType<typeof placement>,
    expected: boolean
  ) => {
    expect(populationPlacementCandidatesConflict(left, right)).toBe(expected);
    expect(populationPlacementCandidatesConflict(right, left)).toBe(expected);
  };

  it("uses explicit symmetric Resin Crawler spacing without changing generic pairs", () => {
    const sap = placement("sap_crawler_group", 0);
    expect(SAP_CRAWLER_TREE_MINIMUM_SPACING_M).toBe(20);
    expect(SAP_CRAWLER_DEER_MINIMUM_SPACING_M).toBe(35);
    expect(SAP_CRAWLER_GROUP_MINIMUM_SPACING_M).toBe(350);
    expect(SAP_CRAWLER_HOSTILE_MINIMUM_SPACING_M).toBe(350);
    expectSymmetric(sap, placement("tree", 0), true);
    expectSymmetric(sap, placement("tree", 21), false);
    expectSymmetric(sap, placement("deer", 34), true);
    expectSymmetric(sap, placement("deer", 36), false);
    expectSymmetric(sap, placement("sap_crawler_group", 349), true);
    expectSymmetric(sap, placement("sap_crawler_group", 351), false);
    expectSymmetric(sap, placement("wolf_pack", 349), true);
    expectSymmetric(sap, placement("wolf_pack", 351), false);
    expectSymmetric(sap, placement("ogre", 349), true);
    expectSymmetric(sap, placement("ogre", 351), false);
    expectSymmetric(sap, placement("stone", 119), true);
    expectSymmetric(sap, placement("stone", 121), false);
    expectSymmetric(placement("tree", 0), placement("deer", 34), true);
  });
});

describe("population zones v2 habitat sampling", () => {
  it("uses 48 deterministic spherical-area samples", () => {
    const zoneId = populationZoneV2IdForPoint({ lat: 69.6492, lon: 18.9553 });
    const first = populationZoneV2HabitatSamplePoints({
      zoneId,
      worldEnvironmentIdentityKey: WORLD_IDENTITY
    });
    const second = populationZoneV2HabitatSamplePoints({
      zoneId,
      worldEnvironmentIdentityKey: WORLD_IDENTITY
    });
    expect(first).toEqual(second);
    expect(first).toHaveLength(POPULATION_ZONE_V2_HABITAT_SAMPLE_COUNT);
    expect(first.reduce((sum, sample) => sum + sample.areaWeightKm2, 0))
      .toBeCloseTo(populationZoneV2Geometry(zoneId).areaKm2, 12);
    expect(first.every((sample) =>
      populationZoneV2IdForPoint(sample.position) === zoneId
    )).toBe(true);
  });

  it("stays within 0.08 eligible-area fraction of 1,024-sample references", async () => {
    for (const fixture of [waterHeavyFacts, biomeBoundaryFacts]) {
      const zoneId = populationZoneV2IdForPoint({
        lat: fixture === waterHeavyFacts ? 29.2 : 35.6,
        lon: fixture === waterHeavyFacts ? -89.3 : -83.5
      });
      const geometry = populationZoneV2Geometry(zoneId);
      const estimate = await estimatePopulationZoneV2Habitat({
        zoneId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY,
        regionCode: "fixture",
        factsForPoint: (sample) => fixture(geometry, sample.position)
      });
      const reference = await estimatePopulationZoneV2Habitat({
        zoneId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY,
        regionCode: "fixture",
        sampleCount: 1_024,
        factsForPoint: (sample) => fixture(geometry, sample.position)
      });
      expect(estimate.status).toBe("ready");
      for (const key of [
        "eligibleLandKm2",
        "treeKm2",
        "deerKm2",
        "wolfKm2",
        "stoneKm2",
        "ogreKm2"
      ] as const) {
        expect(
          Math.abs(estimate.habitat[key] - reference.habitat[key])
            / geometry.areaKm2
        ).toBeLessThan(0.08);
      }
    }
  });

  it("counts missing World facts as zero and requires a retry", async () => {
    const zoneId = populationZoneV2IdForPoint({ lat: 25.45, lon: -80.75 });
    const estimate = await estimatePopulationZoneV2Habitat({
      zoneId,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      regionCode: "fixture",
      factsForPoint: (sample) => sample.sampleId.endsWith("/0")
        ? null
        : landFacts("wetland")
    });
    expect(estimate.status).toBe("retryable-missing-facts");
    expect(estimate.missingSampleIds).toHaveLength(1);
    expect(estimate.habitat.eligibleLandKm2).toBeLessThan(
      populationZoneV2Geometry(zoneId).areaKm2
    );
    expect(estimate.habitat.habitatSummary).toMatchObject({
      missingSampleCount: 1,
      missingFactsAreZeroAndRetryable: true
    });
  });

  it("uses all eligible land for trees regardless of environment keywords", async () => {
    const zoneId = populationZoneV2IdForPoint({ lat: 35.0844, lon: -106.6504 });
    const areaKm2 = populationZoneV2Geometry(zoneId).areaKm2;
    for (const environment of [
      "desert",
      "barren bare-rock",
      "tundra ice",
      "montane mountain",
      "grassland savanna",
      "wetland mangrove",
      "temperate forest"
    ]) {
      const estimate = await estimatePopulationZoneV2Habitat({
        zoneId,
        worldEnvironmentIdentityKey: WORLD_IDENTITY,
        regionCode: "fixture",
        factsForPoint: () => landFacts(environment)
      });
      expect(estimate.status).toBe("ready");
      expect(estimate.habitat.treeKm2).toBeCloseTo(areaKm2, 12);
    }
  });
});

function generationWithAllPopulationKinds(): Readonly<{
  desired: readonly PopulationZoneV2PlanSlot[];
}> {
  const zoneId = populationZoneV2IdForPoint({
    lat: 34.98,
    lon: -106.55
  });
  const template = generatePopulationZonesV2Plans({
    outputZoneIds: [zoneId],
    worldEnvironmentIdentityKey: WORLD_IDENTITY,
    worldPipelineSha: WORLD_SHA,
    habitatForZone: (ownerId) => populationZoneV3ConservativeHabitat({
      zoneId: ownerId,
      worldEnvironmentIdentityKey: WORLD_IDENTITY
    })
  })[0]!;
  const generationId = populationZoneV2GenerationId({
    identity: template.identity,
    generationNumber: 1
  });
  const generated = generatePopulationZoneV2GenerationSlots({
    template,
    generationId,
    generationNumber: 1
  }).slots;
  const desired = [...generated];
  if (desired.filter((slot) => slot.entityKind === "tree").length < 2) {
    desired.push(standaloneTemplateSlot("tree", 0));
  }
  if (desired.filter((slot) => slot.entityKind === "deer").length < 2) {
    desired.push(standaloneTemplateSlot("deer", 1));
  }
  if (!desired.some((slot) => slot.entityKind === "ogre")) {
    desired.push(standaloneTemplateSlot("ogre", 2));
  }
  let wolfTemplateIndex = 0;
  while (groupWolfPacks(desired).size < 2) {
    desired.push(...wolfTemplatePack(wolfTemplateIndex === 0 ? "" : String(wolfTemplateIndex)));
    wolfTemplateIndex += 1;
  }
  return { desired };
}

function groupWolfPacks(
  slots: readonly PopulationZoneV2PlanSlot[]
): Map<string, PopulationZoneV2PlanSlot[]> {
  const packs = new Map<string, PopulationZoneV2PlanSlot[]>();
  for (const slot of slots) {
    if (slot.entityKind !== "wolf" || slot.packId === null) continue;
    const members = packs.get(slot.packId) ?? [];
    members.push(slot);
    packs.set(slot.packId, members);
  }
  return packs;
}

function sapCrawlerTemplateGroup(
  size: 5 | 6 | 7,
  candidateId: string,
  latitudeOffset = 0
): PopulationZoneV2PlanSlot[] {
  const anchor = { lat: 35 + latitudeOffset, lon: -106 };
  const encounterId = deterministicUuidV8("sap-template-encounter", {
    candidateId
  });
  const packId = deterministicUuidV8("sap-template-pack", { candidateId });
  return Array.from({ length: size }, (_, packMemberIndex) => ({
    slotId: deterministicUuidV8("sap-template-slot", {
      candidateId,
      packMemberIndex
    }),
    entityId: deterministicUuidV8("sap-template-entity", {
      candidateId,
      packMemberIndex
    }),
    candidateId,
    entityKind: "sap_crawler",
    archetype: "sap_crawler",
    encounterId,
    packId,
    packMemberIndex,
    position: destinationPoint(anchor, packMemberIndex * 8, 72),
    anchor,
    environmentSnapshot: {
      fixture: "Resin Crawler template",
      candidateSite: { packMemberIndex }
    },
    suppressionClass: "hostile-pack"
  }));
}

function wolfTemplatePack(suffix = ""): PopulationZoneV2PlanSlot[] {
  const offset = suffix === "" ? 0 : Number(suffix);
  const anchor = { lat: 45 + offset, lon: -80 - offset };
  const candidateId = `reconciliation-wolf-pack${suffix ? `-${suffix}` : ""}`;
  const encounterId = deterministicUuidV8("wolf-template-encounter", {
    candidateId
  });
  const packId = deterministicUuidV8("wolf-template-pack", { candidateId });
  return Array.from({ length: 2 }, (_, packMemberIndex) => ({
    slotId: deterministicUuidV8("wolf-template-slot", {
      candidateId,
      packMemberIndex
    }),
    entityId: deterministicUuidV8("wolf-template-entity", {
      candidateId,
      packMemberIndex
    }),
    candidateId,
    entityKind: "wolf",
    archetype: "wolf",
    encounterId,
    packId,
    packMemberIndex,
    position: destinationPoint(anchor, packMemberIndex * 60, 90),
    anchor,
    environmentSnapshot: { fixture: "wolf template" },
    suppressionClass: "hostile-pack"
  }));
}

function standaloneTemplateSlot(
  entityKind: "tree" | "deer" | "ogre",
  index: number
): PopulationZoneV2PlanSlot {
  const candidateId = `reconciliation-${entityKind}-${index}`;
  const position = { lat: 80 - index, lon: 150 + index };
  return {
    slotId: deterministicUuidV8("standalone-template-slot", { candidateId }),
    entityId: deterministicUuidV8("standalone-template-entity", { candidateId }),
    candidateId,
    entityKind,
    archetype: entityKind,
    encounterId: deterministicUuidV8("standalone-template-encounter", { candidateId }),
    packId: null,
    packMemberIndex: null,
    position,
    anchor: position,
    environmentSnapshot: { fixture: "standalone template" },
    suppressionClass: entityKind === "deer"
      ? "deer-safe"
      : entityKind === "ogre"
        ? "hostile-ogre"
        : "none"
  };
}

function fullHabitat(zoneId: PopulationZoneV2Id): PopulationZoneV2Habitat {
  const areaKm2 = populationZoneV2Geometry(zoneId).areaKm2;
  return {
    regionCode: "fixture",
    eligibleLandKm2: areaKm2,
    treeKm2: areaKm2,
    deerKm2: areaKm2,
    wolfKm2: areaKm2,
    stoneKm2: areaKm2,
    ogreKm2: areaKm2,
    habitatSummary: { fixture: "fully-land" },
    environmentSnapshot: { fixture: "fully-land" }
  };
}

function waterHeavyFacts(
  geometry: ReturnType<typeof populationZoneV2Geometry>,
  point: Readonly<{ lat: number; lon: number }>
): PopulationZoneV2HabitatFacts {
  const { longitudeUnit, latitudeUnit } = pointUnits(geometry, point);
  const isLand = longitudeUnit
    + 0.12 * Math.sin(latitudeUnit * Math.PI * 4) < 0.3;
  return isLand ? landFacts("wetland") : waterFacts();
}

function biomeBoundaryFacts(
  geometry: ReturnType<typeof populationZoneV2Geometry>,
  point: Readonly<{ lat: number; lon: number }>
): PopulationZoneV2HabitatFacts {
  const { longitudeUnit, latitudeUnit } = pointUnits(geometry, point);
  return landFacts(
    longitudeUnit + latitudeUnit < 0.95
      ? "temperate-forest"
      : "hot-desert"
  );
}

function pointUnits(
  geometry: ReturnType<typeof populationZoneV2Geometry>,
  point: Readonly<{ lat: number; lon: number }>
): Readonly<{ longitudeUnit: number; latitudeUnit: number }> {
  const southSine = Math.sin(geometry.bounds.southLat * Math.PI / 180);
  const northSine = Math.sin(geometry.bounds.northLat * Math.PI / 180);
  return {
    longitudeUnit: (point.lon - geometry.bounds.westLon)
      / (geometry.bounds.eastLon - geometry.bounds.westLon),
    latitudeUnit: (
      Math.sin(point.lat * Math.PI / 180) - southSine
    ) / (northSine - southSine)
  };
}

function landFacts(biome: string): PopulationZoneV2HabitatFacts {
  return {
    isLand: true,
    isSaltwater: false,
    isCoastalLand: false,
    insideMajorLake: false,
    isCoastal: biome === "wetland",
    elevationBand: "lowland",
    terrainClass: "flat",
    landCoverClass: biome,
    biomeId: biome,
    biomeName: biome,
    ecoregionId: biome,
    ecoregionName: biome,
    spawnProfileKey: biome
  };
}

function waterFacts(): PopulationZoneV2HabitatFacts {
  return {
    ...landFacts("open-water"),
    isLand: false,
    isSaltwater: true,
    isCoastal: true
  };
}

function waterHeavyCandidateSlots(
  geometry: ReturnType<typeof populationZoneV2Geometry>
): WorldEnvironmentCandidateSlot[] {
  return generateWorldEnvironmentCandidateSlots({
    cellId: `water-heavy-${geometry.id}`,
    candidateSlotVersion: "water-heavy-candidate-slots-v1",
    center: geometry.center
  }, 112, 650).map((point) => {
    const eligibleLand = waterHeavyLandAt(geometry, point.position);
    return {
      slotId: point.slotId,
      latitude: point.position.lat,
      longitude: point.position.lon,
      eligibleLand,
      isSaltwater: !eligibleLand,
      insideMajorLake: false,
      isRiverbank: false,
      isLakeshore: false,
      elevationM: eligibleLand ? 4 : 0,
      elevationBand: "lowland",
      terrainClass: "flat",
      landCoverClass: eligibleLand ? "wetland-forest" : "open-water",
      biomeId: eligibleLand ? "wetland-forest" : "open-water",
      biomeName: eligibleLand ? "Wetland Forest" : "Open Water",
      ecoregionId: eligibleLand ? "wetland" : "water",
      ecoregionName: eligibleLand ? "Wetland" : "Water",
      placementTags: [
        ...point.placementTags,
        eligibleLand ? "eligible-land" : "water"
      ]
    };
  });
}

function waterHeavyProfileFacts(
  geometry: ReturnType<typeof populationZoneV2Geometry>,
  point: Readonly<{ lat: number; lon: number }>,
  candidateSlots: readonly WorldEnvironmentCandidateSlot[]
): PopulationZoneV2HabitatFacts {
  const facts = waterHeavyLandAt(geometry, point)
    ? landFacts("wetland-forest")
    : waterFacts();
  return {
    ...facts,
    sourceCellId: `water-heavy-${geometry.id}`,
    candidateSlotVersion: "water-heavy-candidate-slots-v1",
    candidateSlots
  };
}

function waterHeavyLandAt(
  geometry: ReturnType<typeof populationZoneV2Geometry>,
  point: Readonly<{ lat: number; lon: number }>
): boolean {
  const { longitudeUnit, latitudeUnit } = pointUnits(geometry, point);
  return longitudeUnit
    + 0.08 * Math.sin(latitudeUnit * Math.PI * 4) < 0.46;
}

function zeroHabitat(zoneId: PopulationZoneV2Id): PopulationZoneV2Habitat {
  return {
    regionCode: "zero-fixture",
    eligibleLandKm2: 0,
    treeKm2: 0,
    deerKm2: 0,
    wolfKm2: 0,
    stoneKm2: 0,
    ogreKm2: 0,
    habitatSummary: { fixture: "zero", zoneId },
    environmentSnapshot: { fixture: "zero" }
  };
}

function rareOnlyHabitat(
  habitat: PopulationZoneV2Habitat
): PopulationZoneV2Habitat {
  return {
    ...habitat,
    treeKm2: 0,
    deerKm2: 0,
    wolfKm2: 0,
    candidateSites: habitat.candidateSites!.map((site) => ({
      ...site,
      weights: {
        ...site.weights,
        tree: 0,
        deer: 0,
        wolf: 0
      }
    }))
  };
}

function stoneOnlyHabitat(
  habitat: PopulationZoneV2Habitat
): PopulationZoneV2Habitat {
  return {
    ...habitat,
    treeKm2: 0,
    deerKm2: 0,
    wolfKm2: 0,
    ogreKm2: 0,
    candidateSites: habitat.candidateSites!.map((site) => ({
      ...site,
      weights: {
        ...site.weights,
        tree: 0,
        deer: 0,
        wolf: 0,
        ogre: 0
      }
    }))
  };
}

function habitatSiteWeightForEntity(
  site: PopulationZoneV2HabitatCandidateSite,
  kind: PopulationZoneV2PlanSlot["entityKind"]
): number {
  const planKind = kind === "wolf"
    ? "wolf_pack"
    : kind === "sap_crawler"
      ? "sap_crawler_group"
      : kind === "tree"
        || kind === "deer"
        || kind === "stone"
        || kind === "ogre"
        || kind === "flax"
        ? kind
        : null;
  if (planKind === null) {
    throw new Error(`unexpected legacy fixture entity kind ${kind}`);
  }
  return habitatSiteWeightForPlanKind(site, planKind);
}

function habitatSiteWeightForPlanKind(
  site: PopulationZoneV2HabitatCandidateSite,
  kind: PopulationZoneV2PlanKind
): number {
  switch (kind) {
    case "tree": return site.weights.tree;
    case "flax": return site.weights.flax ?? 0;
    case "deer": return site.weights.deer;
    case "wolf_pack": return site.weights.wolf;
    case "stone": return site.weights.stone;
    case "ogre": return site.weights.ogre;
    case "sap_crawler_group": return site.weights.eligibleLand;
  }
}

function firstOwnerLocalCandidateCluster(
  geometry: ReturnType<typeof populationZoneV2Geometry>
): CandidateSlotPoint[] {
  const points = generateWorldEnvironmentCandidateSlots({
    cellId: `wolf-cluster-${geometry.id}`,
    candidateSlotVersion: "wolf-cluster-fixture-v1",
    center: geometry.center
  }, 112, 250);
  const clusters = new Map<string, CandidateSlotPoint[]>();
  for (const point of points) {
    const cluster = point.placementTags.find((tag) =>
      tag.startsWith("cluster:")
    );
    if (cluster === undefined) continue;
    const entries = clusters.get(cluster) ?? [];
    entries.push(point);
    clusters.set(cluster, entries);
  }
  const selected = [...clusters.values()].find((cluster) =>
    cluster.length === 7
    && cluster.every((point) =>
      populationZoneV2IdForPoint(point.position) === geometry.id
    )
  );
  if (selected === undefined) {
    throw new Error("wolf fixture could not find an owner-local cluster");
  }
  return selected;
}

function firstOwnerLocalSapCrawlerCluster(
  geometry: ReturnType<typeof populationZoneV2Geometry>
): CandidateSlotPoint[] {
  const points = generateWorldEnvironmentCandidateSlots({
    cellId: `sap-crawler-cluster-${geometry.id}`,
    candidateSlotVersion: "sap-crawler-cluster-fixture-v1",
    center: geometry.center
  }, 112, 250);
  const clusters = new Map<string, CandidateSlotPoint[]>();
  for (const point of points) {
    const key = point.placementTags.find((tag) => tag.startsWith("cluster:"));
    if (key === undefined) continue;
    const cluster = clusters.get(key) ?? [];
    cluster.push(point);
    clusters.set(key, cluster);
  }
  const selected = [...clusters.values()].find((cluster) => {
    const domainIds = new Set(cluster.map((point) =>
      populationZoneV2RareParentDomainForPoint(
        "sap_crawler_group",
        point.position
      ).id
    ));
    return cluster.length === 7
      && domainIds.size === 1
      && cluster.every((point) =>
        populationZoneV2IdForPoint(point.position) === geometry.id
      );
  });
  if (selected === undefined) {
    throw new Error("Resin Crawler fixture could not find one owner-local domain cluster");
  }
  return selected;
}

function sapCrawlerCandidateSite(
  point: CandidateSlotPoint
): PopulationZoneV2HabitatCandidateSite {
  return {
    ...testCandidateSite(point, true),
    siteId: `sap-crawler-fixture/${point.slotId}`,
    source: "synthetic-sample-center",
    sourceSampleId: "sap-crawler-fixture-sample",
    sourceCellId: "sap-crawler-fixture-cell",
    candidateSlotVersion: "sap-crawler-cluster-fixture-v1",
    isSaltwater: false,
    insideMajorLake: false,
    weights: {
      eligibleLand: 1,
      tree: 1,
      deer: 0,
      wolf: 0,
      stone: 0,
      ogre: 0
    }
  };
}

function candidateIdForSapCrawlerSize(memberCount: 5 | 6 | 7): string {
  for (let index = 0; index < 10_000; index += 1) {
    const candidateId = `sap-crawler-size-fixture/${index}`;
    if (legacySapCrawlerGroupSizeForUnit(deterministicUnit(
      "population-sap-crawler-group-size-v1",
      candidateId
    )) === memberCount) {
      return candidateId;
    }
  }
  throw new Error(`could not find Resin Crawler ${memberCount}-member fixture`);
}

function testCandidateSite(
  point: CandidateSlotPoint,
  wolfEligible: boolean
): PopulationZoneV2HabitatCandidateSite {
  const weights: PopulationZoneV2HabitatWeights = {
    eligibleLand: wolfEligible ? 1 : 0,
    tree: 0,
    deer: 0,
    wolf: wolfEligible ? 1 : 0,
    stone: 0,
    ogre: 0
  };
  return {
    siteId: `wolf-fixture/${point.slotId}`,
    position: point.position,
    source: "world-profile-candidate-slot",
    sourceSampleId: "wolf-fixture-sample",
    sourceCellId: "wolf-fixture-cell",
    sourceSlotId: point.slotId,
    candidateSlotVersion: "wolf-cluster-fixture-v1",
    placementTags: point.placementTags,
    isSaltwater: !wolfEligible,
    insideMajorLake: false,
    elevationBand: "lowland",
    terrainClass: "plain",
    landCoverClass: wolfEligible ? "forest" : "open-water",
    biomeId: wolfEligible ? "temperate-forest" : "open-water",
    ecoregionId: wolfEligible ? "forest" : "water",
    spawnProfileKey: wolfEligible ? "forest" : "open-water",
    weights
  };
}

function identityWithOneWolfCandidate(
  zoneId: PopulationZoneV2Id,
  wolfKm2: number
): string {
  for (let value = 1; value < 4_096; value += 1) {
    const identity = value.toString(16).padStart(64, "0");
    if (deterministicEligibleAreaCount({
      ownerId: zoneId,
      kind: "wolf_pack",
      eligibleAreaKm2: wolfKm2,
      densityPerEligibleKm2:
        POPULATION_BALANCE.common.wolf_pack.densityPerEligibleKm2
        * POPULATION_BALANCE.common.wolf_pack.candidateOversamplingFactor,
      worldEnvironmentIdentityKey: identity
    }) === 1) return identity;
  }
  throw new Error("wolf fixture could not find a deterministic candidate");
}

function habitatWithCandidateSites(
  zoneId: PopulationZoneV2Id,
  candidateSites: readonly PopulationZoneV2HabitatCandidateSite[],
  wolfKm2: number
): PopulationZoneV2Habitat {
  const areaKm2 = populationZoneV2Geometry(zoneId).areaKm2;
  return {
    regionCode: "wolf-cluster-fixture",
    eligibleLandKm2: Math.min(areaKm2, wolfKm2),
    treeKm2: 0,
    deerKm2: 0,
    wolfKm2: Math.min(areaKm2, wolfKm2),
    stoneKm2: 0,
    ogreKm2: 0,
    habitatSummary: { fixture: "wolf-cluster" },
    environmentSnapshot: { fixture: "wolf-cluster" },
    candidateSites
  };
}

function conflictViolations(slots: readonly PopulationZoneV2PlanSlot[]) {
  const trees = slots.filter((slot) => slot.entityKind === "tree");
  const deer = slots.filter((slot) => slot.entityKind === "deer");
  const wolves = slots.filter((slot) => slot.entityKind === "wolf");
  const ogres = slots.filter((slot) => slot.entityKind === "ogre");
  const stones = slots.filter((slot) => slot.entityKind === "stone");
  const scenery = [...trees, ...deer];
  const hostile = [...wolves, ...ogres];
  const mobs = [...deer, ...wolves, ...ogres];
  const packAnchors = uniquePackAnchors(wolves);
  const hostileAnchors = [
    ...packAnchors.map((anchor) => ({ kind: "wolf", anchor })),
    ...ogres.map((slot) => ({ kind: "ogre", anchor: slot.anchor }))
  ];
  return {
    treeTree: pairViolations(trees, trees, 70, true),
    deerDeer: pairViolations(deer, deer, 45, true),
    treeDeer: pairViolations(trees, deer, 35),
    sceneryHostile: pairViolations(scenery, hostile, 70),
    wolfPackAnchors: pointPairViolations(
      packAnchors,
      packAnchors,
      POPULATION_BALANCE.common.wolf_pack.minimumSpacingM,
      true
    ),
    otherHostileAnchors: hostileAnchors.reduce((count, left, leftIndex) =>
      count + hostileAnchors.slice(leftIndex + 1).filter((right) =>
        (left.kind === "ogre" || right.kind === "ogre")
        && distance(left.anchor, right.anchor) < 350
      ).length, 0),
    wolfMembers: pairViolations(wolves, wolves, 55, true, (left, right) =>
      left.packId === right.packId
    ),
    stoneTree: pairViolations(stones, trees, 50),
    stoneMob: pairViolations(stones, mobs, 120)
  };
}

function uniquePackAnchors(
  wolves: readonly PopulationZoneV2PlanSlot[]
): Readonly<{ lat: number; lon: number }>[] {
  const anchors = new Map<string, Readonly<{ lat: number; lon: number }>>();
  for (const wolf of wolves) {
    if (wolf.packId !== null) anchors.set(wolf.packId, wolf.anchor);
  }
  return [...anchors.values()];
}

function pairViolations(
  left: readonly PopulationZoneV2PlanSlot[],
  right: readonly PopulationZoneV2PlanSlot[],
  spacingM: number,
  sameSet = false,
  include: (
    left: PopulationZoneV2PlanSlot,
    right: PopulationZoneV2PlanSlot
  ) => boolean = () => true
): number {
  let count = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (sameSet && rightIndex <= leftIndex) continue;
      if (!include(left[leftIndex]!, right[rightIndex]!)) continue;
      if (distance(left[leftIndex]!.position, right[rightIndex]!.position) < spacingM) {
        count += 1;
      }
    }
  }
  return count;
}

function pointPairViolations(
  left: readonly Readonly<{ lat: number; lon: number }>[],
  right: readonly Readonly<{ lat: number; lon: number }>[],
  spacingM: number,
  sameSet = false
): number {
  let count = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (sameSet && rightIndex <= leftIndex) continue;
      if (distance(left[leftIndex]!, right[rightIndex]!) < spacingM) count += 1;
    }
  }
  return count;
}

function distance(
  left: Readonly<{ lat: number; lon: number }>,
  right: Readonly<{ lat: number; lon: number }>
): number {
  return greatCircleDistanceMeters(left, right);
}
