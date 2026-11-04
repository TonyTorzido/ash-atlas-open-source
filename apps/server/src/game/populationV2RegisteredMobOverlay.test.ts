import { destinationPoint } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { MOB_DEFINITIONS } from "./combat/mobDefinitions.js";
import {
  POPULATION_V2_MOB_DEFINITIONS,
  createPopulationV2MobRegistry,
  createSinglePopulationV2MobCandidateBuilder,
  type PopulationV2MobDefinition
} from "./populationV2MobRegistry.js";
import {
  planPopulationV2RegisteredMobOverlay as planRegisteredOverlay,
  populationV2RegisteredMobFormation,
  type PopulationV2RegisteredMobOccupiedSlot
} from "./populationV2RegisteredMobOverlay.js";
import { greatCircleDistanceMeters } from "./populationZonesV2Geometry.js";
import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite
} from "./populationZonesV2Plan.js";

const GENERATION_ID = "10000000-0000-8000-8000-000000000001";
// Exercise the overlay engine with current authored formations; production uses encounter tables.
const OVERLAY_TEST_DEFINITIONS = POPULATION_V2_MOB_DEFINITIONS.map((definition) => ({
  ...definition, generationPlacement: "registered_overlay" as const
}));
const OVERLAY_TEST_REGISTRY = createPopulationV2MobRegistry(OVERLAY_TEST_DEFINITIONS);
const SAP = OVERLAY_TEST_REGISTRY.requireDefinition("sap_crawler");
const TOP_UP_TEST_REGISTRY = createPopulationV2MobRegistry(
  OVERLAY_TEST_DEFINITIONS.map((definition) =>
    definition.mobKind === "sap_crawler"
      ? { ...definition, existingGenerationRolloutEligible: true }
      : definition
  ) as PopulationV2MobDefinition[]
);

function planPopulationV2RegisteredMobOverlay(
  input: Parameters<typeof planRegisteredOverlay>[0]
) {
  return planRegisteredOverlay({
    ...input,
    registry: input.registry ?? OVERLAY_TEST_REGISTRY,
    mobKinds: input.mobKinds ?? ["sap_crawler"],
    ...(input.mode === "existing_generation_top_up" && input.registry === undefined
      ? { registry: TOP_UP_TEST_REGISTRY }
      : {})
  });
}

describe("Population V2 registered-mob overlay", () => {
  it("plans the live-shaped Resin Crawler density as complete flat-anchor groups", () => {
    const inputHabitat = habitat(218.17, 64);
    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: []
    });
    const sap = result.mobs[0]!;
    expect(sap.placementRevision).toBe("encounter-v1-sap-crawler-formation-v2");
    expect(sap.target.groups).toBeGreaterThanOrEqual(27);
    expect(sap.target.groups).toBeLessThanOrEqual(28);
    expect(sap.inserted.groups).toBe(sap.target.groups);
    expect(sap.shortfall).toEqual({ groups: 0, bodies: 0 });

    const groups = groupByCandidate(result.slots);
    expect(groups.size).toBe(sap.target.groups);
    for (const slots of groups.values()) {
      expect([3, 4]).toContain(slots.length);
      expect(new Set(slots.map((slot) => slot.packMemberIndex)).size)
        .toBe(slots.length);
      expect(new Set(slots.map((slot) => slot.sourceAnchorSiteId)).size)
        .toBe(1);
      for (const slot of slots) {
        const radiusM = greatCircleDistanceMeters(slot.anchor, slot.position);
        expect(radiusM).toBeGreaterThanOrEqual(17.99);
        expect(radiusM).toBeLessThan(30.01);
        expect(slot.environmentSnapshot.sourceAnchorSiteId)
          .toBe(slot.sourceAnchorSiteId);
      }
    }
  });

  it("applies an authored habitat policy at the registered anchor seam", () => {
    const registry = createPopulationV2MobRegistry(
      OVERLAY_TEST_DEFINITIONS.map((definition) =>
        definition.mobKind === "sap_crawler"
          ? {
              ...definition,
              habitatPolicy: {
                requiredFacts: { isRiverbank: true },
                requiredPlacementTags: ["riverbank"]
              }
            }
          : definition
      )
    );
    const candidates = [
      { ...candidateSite(0), isRiverbank: false },
      {
        ...candidateSite(1),
        isRiverbank: true,
        placementTags: ["flat-anchor", "riverbank"]
      }
    ];
    const result = planRegisteredOverlay({
      generationId: GENERATION_ID,
      habitat: { ...habitat(8, 0), candidateSites: candidates },
      occupiedSlots: [],
      mobKinds: ["sap_crawler"],
      registry
    });

    expect(result.mobs[0]?.eligibleAnchorCount).toBe(1);
    expect(result.slots.every((slot) =>
      slot.sourceAnchorSiteId === candidates[1]!.siteId
    )).toBe(true);
  });

  it("hits the configured 4,096 square-kilometre density", () => {
    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: habitat(4_096, 700),
      occupiedSlots: []
    });
    expect(result.mobs[0]).toMatchObject({
      target: { groups: 512 },
      inserted: { groups: 512 },
      shortfall: { groups: 0 }
    });
    expect(groupByCandidate(result.slots).size).toBe(512);
  });

  it("keeps the authored Resin Crawler 37.5/62.5 distribution over 10,000 groups", () => {
    const counts = new Map<number, number>([[3, 0], [4, 0]]);
    for (let index = 0; index < 10_000; index += 1) {
      const positions = populationV2RegisteredMobFormation(
        SAP,
        `distribution-candidate-${index}`,
        { lat: 35, lon: -106 }
      );
      counts.set(positions.length, counts.get(positions.length)! + 1);
    }
    expect(Math.abs(counts.get(3)! / 10_000 - 0.375)).toBeLessThan(0.02);
    expect(Math.abs(counts.get(4)! / 10_000 - 0.625)).toBeLessThan(0.02);
  });

  it("creates only 1-3 member Deer groups at the authored group density", () => {
    const deer = OVERLAY_TEST_REGISTRY.requireDefinition("deer");
    const result = planRegisteredOverlay({
      generationId: GENERATION_ID,
      habitat: habitat(100, 512),
      occupiedSlots: [],
      mobKinds: ["deer"],
      registry: OVERLAY_TEST_REGISTRY
    });
    expect(result.mobs[0]).toMatchObject({
      placementRevision: "encounter-v1-deer-formation-v2",
      target: { groups: 256 },
      shortfall: { groups: 0 }
    });
    const groups = groupByCandidate(result.slots);
    expect(groups.size).toBe(256);
    expect([...groups.values()].every((slots) => [1, 2, 3].includes(slots.length)))
      .toBe(true);
    expect(new Set(result.slots.map((slot) => slot.entityId)).size)
      .toBe(result.slots.length);
    expect(deer.density).toMatchObject({ densityPerEligibleKm2: 2.56 });
    expect(2.56 * (0.2 + 2 * 0.4 + 3 * 0.4)).toBeCloseTo(5.632, 10);
  });

  it("uses occupied complete groups for top-up and makes the second run a no-op", () => {
    const inputHabitat = habitat(16, 12);
    const desired = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: []
    });
    expect(desired.inserted.groups).toBe(2);
    const groups = [...groupByCandidate(desired.slots).values()];
    const retained = groups[0]!;
    const topUp = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: retained,
      mode: "existing_generation_top_up",
      mobKinds: ["sap_crawler"]
    });
    expect(topUp.current.groups).toBe(1);
    expect(topUp.inserted.groups).toBe(1);
    expect(topUp.shortfall.groups).toBe(0);

    const replay = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: [...retained, ...topUp.slots],
      mode: "existing_generation_top_up",
      mobKinds: ["sap_crawler"]
    });
    expect(replay.current.groups).toBe(2);
    expect(replay.inserted).toEqual({ groups: 0, bodies: 0 });
    expect(replay.slots).toEqual([]);
  });

  it("does not let a previous placement revision satisfy the current revision", () => {
    const inputHabitat = habitat(16, 32);
    const previous = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: [],
      registry: registryWithSapRevision("sap-crawler-flat-anchor-v0")
    });
    expect(previous.inserted.groups).toBe(2);

    const current = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: previous.slots,
      mode: "existing_generation_top_up",
      mobKinds: ["sap_crawler"],
      registry: registryWithSapRevision("sap-crawler-flat-anchor-v2")
    });

    expect(current.current).toEqual({ groups: 0, bodies: 0 });
    expect(current.inserted.groups).toBe(2);
    expect(current.shortfall.groups).toBe(0);
    expect(current.slots.every((slot) =>
      slot.placementRevision === "sap-crawler-flat-anchor-v2"
    )).toBe(true);
    expect(groupByCandidate(current.slots).size).toBe(2);
    expect(new Set(current.slots.map((slot) => slot.sourceAnchorSiteId)))
      .not.toEqual(
        new Set(previous.slots.map((slot) => slot.sourceAnchorSiteId))
      );
  });

  it("makes partial persisted groups terminal instead of filling around them", () => {
    const inputHabitat = habitat(8, 8);
    const desired = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: []
    });
    const partial = [...groupByCandidate(desired.slots).values()][0]!
      .slice(0, 2);
    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: partial,
      mode: "existing_generation_top_up",
      mobKinds: ["sap_crawler"]
    });
    expect(result.status).toBe("terminal_partial_group");
    expect(result.slots).toEqual([]);
    expect(result.terminalPartialGroups).toEqual([
      expect.objectContaining({
        mobKind: "sap_crawler",
        bodyCount: 2,
        reason: "partial_or_corrupt_persisted_group"
      })
    ]);
  });

  it("rejects an allowed-size truncation of a deterministic four-body group", () => {
    const anchor = Array.from(
      { length: 1_000 },
      (_, index) => candidateSite(index)
    ).find((site) =>
      populationV2RegisteredMobFormation(
        SAP,
        site.siteId,
        site.position
      ).length === 4
    );
    if (anchor === undefined) {
      throw new Error("expected a deterministic four-body Resin Crawler anchor");
    }
    const inputHabitat = {
      ...habitat(8, 0),
      candidateSites: [anchor]
    };
    const desired = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: []
    });
    expect(desired.slots).toHaveLength(4);

    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: desired.slots.slice(0, 3),
      mode: "existing_generation_top_up",
      mobKinds: ["sap_crawler"]
    });

    expect(result.status).toBe("terminal_partial_group");
    expect(result.slots).toEqual([]);
    expect(result.terminalPartialGroups).toEqual([
      expect.objectContaining({
        bodyCount: 3,
        expectedMemberCounts: [4]
      })
    ]);
  });

  it("treats a persistence-corrupt complete group as terminal", () => {
    const inputHabitat = habitat(8, 8);
    const desired = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: []
    });
    const complete = [...groupByCandidate(desired.slots).values()][0]!;
    const corrupt = complete.map((slot, index) =>
      index === 0
        ? {
            ...slot,
            persistenceCorruption: "missing generated mob projection"
          }
        : slot
    );

    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: corrupt,
      mode: "existing_generation_top_up",
      mobKinds: ["sap_crawler"]
    });

    expect(result.status).toBe("terminal_partial_group");
    expect(result.slots).toEqual([]);
  });

  it("lets baseline trees win spacing and never mutates legacy slots", () => {
    const oneAnchorHabitat = habitat(8, 1);
    const site = oneAnchorHabitat.candidateSites![0]!;
    const body = populationV2RegisteredMobFormation(SAP, site.siteId, site.position)[0]!;
    const tree = legacyTree(body);
    const before = structuredClone(tree);
    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: oneAnchorHabitat,
      occupiedSlots: [tree]
    });
    expect(result.inserted).toEqual({ groups: 0, bodies: 0 });
    expect(result.shortfall.groups).toBe(1);
    expect(tree).toEqual(before);
    expect((result.slots as readonly Readonly<{ entityKind: string }>[]).some(
      (slot) => slot.entityKind === "tree"
    )).toBe(false);
  });

  it("uses adjacent lives for spacing without counting their density", () => {
    const oneAnchorHabitat = habitat(8, 1);
    const neighbor = planPopulationV2RegisteredMobOverlay({
      generationId: "20000000-0000-8000-8000-000000000002",
      habitat: oneAnchorHabitat,
      occupiedSlots: []
    });
    const target = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: oneAnchorHabitat,
      occupiedSlots: [],
      spacingOccupants: neighbor.slots
    });

    expect(target.current).toEqual({ groups: 0, bodies: 0 });
    expect(target.inserted).toEqual({ groups: 0, bodies: 0 });
    expect(target.shortfall.groups).toBe(1);
  });

  it("never invents anchors when the selected plan has no persisted candidates", () => {
    const { candidateSites, ...noCandidates } = habitat(8, 0);
    expect(candidateSites).toHaveLength(0);
    const result = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: noCandidates,
      occupiedSlots: []
    });
    expect(result.mobs[0]).toMatchObject({
      eligibleAnchorCount: 0,
      inserted: { groups: 0, bodies: 0 },
      shortfall: { groups: 1 }
    });
  });

  it("requires explicit admission for existing-generation top-up", () => {
    expect(() => planRegisteredOverlay({
      generationId: GENERATION_ID,
      habitat: habitat(8, 4),
      occupiedSlots: [],
      mode: "existing_generation_top_up"
    })).toThrow(/explicit mob kinds/i);
  });

  it("injects a normal boar and isolates per-mob revision identities", () => {
    const registryV1 = registryWithBoar("registry-test-boar-placement-v1");
    const registryV2 = registryWithBoar("registry-test-boar-placement-v2");
    const inputHabitat = habitat(16, 24);
    const boarV1 = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: [],
      mobKinds: ["registry_test_boar"],
      registry: registryV1
    });
    const boarV2 = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: [],
      mobKinds: ["registry_test_boar"],
      registry: registryV2
    });
    expect(boarV1.inserted.groups).toBe(2);
    expect(boarV1.slots.every((slot) =>
      slot.entityKind === "registry_test_boar"
      && slot.packId === null
      && slot.packMemberIndex === null
    )).toBe(true);
    expect(boarV1.slots.map((slot) => slot.entityId))
      .not.toEqual(boarV2.slots.map((slot) => slot.entityId));

    const sapOnly = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: []
    });
    const sapWithBoarRegistry = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: inputHabitat,
      occupiedSlots: [],
      registry: registryV1
    });
    expect(sapWithBoarRegistry.slots.filter((slot) =>
      slot.entityKind === "sap_crawler"
    )).toEqual(sapOnly.slots);
  });

  it("rejects a builder that corrupts only production candidates", () => {
    const sap = OVERLAY_TEST_DEFINITIONS.find((definition) =>
      definition.mobKind === "sap_crawler"
    )!;
    const registry = createPopulationV2MobRegistry([
      {
        ...sap,
        candidateBuilder: (input) => {
          const candidate = sap.candidateBuilder(input);
          if (input.candidateId.startsWith(
            "population-v2-registry-validation/"
          )) return candidate;
          return {
            ...candidate,
            members: candidate.members.map((member, index) =>
              index === 1
                ? {
                    ...member,
                    memberIndex: 0,
                    position: candidate.members[0]!.position
                  }
                : member
            )
          };
        }
      }
    ]);

    expect(() => planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: habitat(8, 4),
      occupiedSlots: [],
      registry
    })).toThrow(/mixed or partial group/i);
  });
});

function habitat(
  eligibleLandKm2: number,
  candidateCount: number
): PopulationZoneV2Habitat {
  return {
    regionCode: "registered-overlay-test",
    eligibleLandKm2,
    treeKm2: eligibleLandKm2,
    deerKm2: eligibleLandKm2,
    wolfKm2: eligibleLandKm2,
    stoneKm2: eligibleLandKm2,
    ogreKm2: eligibleLandKm2,
    habitatSummary: {},
    environmentSnapshot: {},
    candidateSites: Array.from(
      { length: candidateCount },
      (_, index) => candidateSite(index)
    )
  };
}

function candidateSite(index: number): PopulationZoneV2HabitatCandidateSite {
  const columns = 32;
  const rowOrigin = destinationPoint(
    { lat: 35, lon: -106 },
    Math.floor(index / columns) * 1_000,
    0
  );
  const position = destinationPoint(
    rowOrigin,
    (index % columns) * 1_000,
    90
  );
  return {
    siteId: `persisted-anchor-${index.toString().padStart(4, "0")}`,
    position,
    source: "world-profile-candidate-slot",
    sourceSampleId: `sample-${index}`,
    sourceCellId: `cell-${Math.floor(index / 8)}`,
    sourceSlotId: `slot-${index}`,
    candidateSlotVersion: "registered-overlay-test-slots-v1",
    placementTags: ["flat-anchor"],
    isSaltwater: false,
    insideMajorLake: false,
    elevationBand: "low",
    terrainClass: "flat",
    landCoverClass: "grassland",
    biomeId: "test-biome",
    ecoregionId: "test-ecoregion",
    spawnProfileKey: "registered-overlay-test",
    weights: {
      eligibleLand: 1,
      tree: 1,
      deer: 1,
      wolf: 1,
      stone: 1,
      ogre: 1
    }
  };
}

function legacyTree(
  position: Readonly<{ lat: number; lon: number }>
): PopulationV2RegisteredMobOccupiedSlot {
  return {
    slotId: "legacy-tree-slot",
    entityId: "legacy-tree-entity",
    candidateId: "legacy-tree-candidate",
    entityKind: "tree",
    archetype: "tree",
    encounterId: null,
    packId: null,
    packMemberIndex: null,
    position,
    anchor: position,
    environmentSnapshot: {},
    suppressionClass: "none"
  };
}

function groupByCandidate<Slot extends Readonly<{ candidateId: string }>>(
  slots: readonly Slot[]
): Map<string, Slot[]> {
  const groups = new Map<string, Slot[]>();
  for (const slot of slots) {
    const group = groups.get(slot.candidateId) ?? [];
    group.push(slot);
    groups.set(slot.candidateId, group);
  }
  return groups;
}

function registryWithBoar(revision: string) {
  const definitions: PopulationV2MobDefinition[] = [
    ...OVERLAY_TEST_DEFINITIONS,
    {
      mobKind: "registry_test_boar",
      combatArchetype: "registry_test_boar",
      placementRevision: revision,
      generationPlacement: "registered_overlay",
      spawnModel: "single",
      behaviorCategory: "hostile",
      mechanicalPhaseEligibility: "ANY",
      plannerPriority: 200,
      density: {
        model: "rare",
        targetAreaKm2: 8,
        candidateOversamplingFactor: 1.25
      },
      eligibleAreaKm2: (inputHabitat) => inputHabitat.eligibleLandKm2,
      isEligibleAnchor: (site) => site.weights.deer > 0,
      candidateBuilder:
        createSinglePopulationV2MobCandidateBuilder("registry_test_boar"),
      spacingClass: "passive_single",
      suppressionClass: "deer-safe",
      clientPresentational: true,
      defaultRolloutPolicy: "next_generation_only",
      existingGenerationRolloutEligible: false,
      diagnosticsLabel: "Registry test boar"
    }
  ];
  return createPopulationV2MobRegistry(definitions, {
    supportedArchetypes: new Set([
      ...Object.keys(MOB_DEFINITIONS),
      "registry_test_boar"
    ])
  });
}

function registryWithSapRevision(revision: string) {
  return createPopulationV2MobRegistry(
    OVERLAY_TEST_DEFINITIONS.map((definition) =>
      definition.mobKind === "sap_crawler"
        ? {
            ...definition,
            placementRevision: revision,
            existingGenerationRolloutEligible: true
          }
        : definition
    ) as PopulationV2MobDefinition[],
    {
      supportedArchetypes: new Set(Object.keys(MOB_DEFINITIONS))
    }
  );
}
