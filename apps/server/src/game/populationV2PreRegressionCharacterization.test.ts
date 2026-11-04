import { createHash } from "node:crypto";

import { POPULATION_DENSITY_REVISION } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import characterization from "./fixtures/population-v2-c9e43f-characterization.js";
import {
  populationZoneV2Geometry,
  populationZoneV2Halo,
  populationZoneV2IdForPoint,
  populationZoneV2Neighbors
} from "./populationZonesV2Geometry.js";
import { ENVIRONMENT_PROFILE_VERSION } from "./gameplayEnvironmentProfileVersions.js";
import {
  canonicalJson,
  POPULATION_CANDIDATE_LAYOUT_VERSION,
  POPULATION_PLAN_VERSION,
  POPULATION_SPAWN_RULES_VERSION,
  POPULATION_RESPAWN_POLICY_VERSION,
  permanentPopulationStoneIdentity,
  populationZoneV2AdvisoryLockKey,
  populationZoneV2PlanId,
  populationZoneV2PlanIdentity,
  type CanonicalJsonValue
} from "./populationZonesV2Identity.js";
import { PopulationZonesV2Backend } from "./populationZonesV2Backend.js";
import type { PopulationZonesV2Planner } from "./populationZonesV2Planner.js";
import {
  generatePopulationZonesV2Plans,
  generatePopulationZoneV2GenerationSlots,
  populationZoneV2GenerationId,
  populationZoneV3ConservativeHabitat,
  type PopulationZoneV2PlanSlot
} from "./populationZonesV2Plan.js";
import {
  type PopulationZoneV2GenerationRecord,
  type PopulationZoneV2ReadyEntity,
  type PopulationZoneV2RuntimeLease,
  type PopulationZoneV2RuntimeLeaseRequest
} from "./populationZonesV2Store.js";

const KINDS = [
  "tree",
  "deer",
  "wolf",
  "ogre",
  "sap_crawler",
  "stone"
] as const;

describe("Population V2 c9e43f pre-regression characterization", () => {
  it("freezes representative equal-area geometry and canonical IDs", () => {
    const zoneId = populationZoneV2IdForPoint(characterization.geometry.point);
    const geometry = populationZoneV2Geometry(zoneId);
    const neighbors = populationZoneV2Neighbors(zoneId);
    const payload = {
      geometry,
      halo2: populationZoneV2Halo(zoneId, 2)
    };

    expect({
      zoneId,
      digest: digest(payload as unknown as CanonicalJsonValue),
      neighbors
    }).toEqual({
      zoneId: characterization.geometry.zoneId,
      digest: characterization.geometry.digest,
      neighbors: characterization.geometry.neighbors
    });
  });

  it("versions plan, generation, and lock identities while retaining permanent-stone authority", () => {
    const identity = populationZoneV2PlanIdentity({
      zoneId: characterization.identity.zoneId,
      worldEnvironmentIdentityKey:
        characterization.worldEnvironmentIdentityKey,
      environmentProfileVersion: ENVIRONMENT_PROFILE_VERSION
    });

    const current = {
      zoneId: identity.zoneId,
      planId: populationZoneV2PlanId(identity),
      advisoryLockKey: populationZoneV2AdvisoryLockKey(identity).toString(),
      generationIds: [1, 2].map((generationNumber) =>
        populationZoneV2GenerationId({ identity, generationNumber })
      ),
      permanentStone: permanentPopulationStoneIdentity({
        identity,
        candidateId: "c9e43f-characterization-stone",
        ownerZoneId: identity.zoneId
      })
    };
    expect(current.zoneId).toBe(characterization.identity.zoneId);
    expect(current.advisoryLockKey).not.toBe(characterization.identity.advisoryLockKey);
    expect(populationZoneV2AdvisoryLockKey({ ...identity }).toString()).toBe(current.advisoryLockKey);
    expect(current.permanentStone).toEqual(characterization.identity.permanentStone);
    expect(current.planId).not.toBe(characterization.identity.planId);
    expect(current.generationIds).not.toEqual(characterization.identity.generationIds);
    expect(populationZoneV2PlanId({ ...identity })).toBe(current.planId);
    expect([1, 2].map((generationNumber) => populationZoneV2GenerationId({ identity: { ...identity }, generationNumber }))).toEqual(current.generationIds);
    expect(identity).toMatchObject({
      populationPlanVersion: POPULATION_PLAN_VERSION,
      spawnRulesVersion: POPULATION_SPAWN_RULES_VERSION,
      candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION,
      respawnPolicyVersion: POPULATION_RESPAWN_POLICY_VERSION
    });
  });

  it("retains historical zones and permanent stones across deterministic current composition", () => {
    const outputZoneIds = populationZoneV2Halo(
      characterization.geometry.zoneId as ReturnType<
        typeof populationZoneV2IdForPoint
      >,
      7
    );
    const plans = generatePopulationZonesV2Plans({
      outputZoneIds,
      worldEnvironmentIdentityKey:
        characterization.worldEnvironmentIdentityKey,
      worldPipelineSha: characterization.worldPipelineSha,
      habitatForZone: (zoneId) => populationZoneV3ConservativeHabitat({
        zoneId,
        worldEnvironmentIdentityKey:
          characterization.worldEnvironmentIdentityKey
      })
    });
    const selectedZoneIds = new Set<string>(characterization.outputZoneIds);
    const generations = plans
      .filter((template) => selectedZoneIds.has(template.identity.zoneId))
      .map((template) => {
      const generationId = populationZoneV2GenerationId({
        identity: template.identity,
        generationNumber: 1
      });
      return generatePopulationZoneV2GenerationSlots({
        template,
        generationId,
        generationNumber: 1
      });
    });
    const templateSlots = plans.flatMap((plan) => plan.slots);
    const generationSlots = generations.flatMap((generation) =>
      generation.slots
    );

    expect(outputZoneIds).toHaveLength(characterization.plan.outputZoneCount);
    expect(digest(outputZoneIds)).toBe(characterization.plan.outputZoneIdsDigest);
    expect(plans).toHaveLength(169);
    expect(generations).toHaveLength(characterization.outputZoneIds.length);
    const counts = countsByKind(templateSlots);
    for (const kind of KINDS) expect(counts[kind], kind).toBeGreaterThan(0);
    expect(generationSlots.some((slot) => slot.entityKind === "stone")).toBe(false);
    expect(generationSlots.some((slot) => slot.entityKind === "tree")).toBe(true);
    expect(new Set(templateSlots.map((slot) => slot.entityId)).size).toBe(templateSlots.length);
    expect(new Set(generationSlots.map((slot) => slot.entityId)).size).toBe(generationSlots.length);

    const replay = generatePopulationZonesV2Plans({
      outputZoneIds,
      worldEnvironmentIdentityKey: characterization.worldEnvironmentIdentityKey,
      worldPipelineSha: characterization.worldPipelineSha,
      habitatForZone: (zoneId) => populationZoneV3ConservativeHabitat({
        zoneId, worldEnvironmentIdentityKey: characterization.worldEnvironmentIdentityKey
      })
    });
    expect(replay.map((plan) => plan.contentHash)).toEqual(plans.map((plan) => plan.contentHash));
    expect(slotsForDigest(replay.flatMap((plan) => plan.slots))).toEqual(slotsForDigest(templateSlots));
    const replaySlots = replay.filter((plan) => selectedZoneIds.has(plan.identity.zoneId)).flatMap((template) =>
      generatePopulationZoneV2GenerationSlots({
        template, generationNumber: 1,
        generationId: populationZoneV2GenerationId({ identity: template.identity, generationNumber: 1 })
      }).slots
    );
    expect(slotsForDigest(replaySlots)).toEqual(slotsForDigest(generationSlots));
  });

  it("freezes ready-state, lease-fence, actor, and sleep mapping", async () => {
    const zoneId = characterization.geometry.zoneId as ReturnType<
      typeof populationZoneV2IdForPoint
    >;
    const generationId = characterization.identity.generationIds[0]!;
    const generatedAt = new Date("2099-01-01T00:00:00.000Z");
    const generation: PopulationZoneV2GenerationRecord = {
      generationId,
      zoneId,
      planId: characterization.identity.planId,
      generationNumber: 1,
      generatedAt,
      expiresAt: new Date(generatedAt.getTime() + 48 * 60 * 60_000),
      status: "active",
      plannedNonStoneCount: 2,
      currentReferenceCount: 1,
      unreferencedAt: null,
      isCurrent: true,
      cleanedAt: null,
      densityRevision: POPULATION_DENSITY_REVISION,
      planContentHash: "c9e43f-runtime-mapping",
      candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION,
      materializationRevision:
        "population-generation-materialization-v4-encounter-tables-v1"
    };
    const entities = runtimeMappingEntities(zoneId, generationId);
    const leaseRequests: PopulationZoneV2RuntimeLeaseRequest[] = [];
    const releasedLeases: PopulationZoneV2RuntimeLease[] = [];
    const spawnedActors: unknown[] = [];
    const planner: Pick<
      PopulationZonesV2Planner,
      "scheduleZones" | "scheduleZonesAndWait"
    > = {
      async scheduleZones(input) {
        return {
          disabled: false,
          readyZoneIds: input.zoneIds,
          pendingZoneIds: []
        };
      },
      async scheduleZonesAndWait(input) {
        return {
          disabled: false,
          readyZoneIds: input.zoneIds,
          pendingZoneIds: []
        };
      }
    };
    const backend = new PopulationZonesV2Backend(
      {
        async ensurePlanForZone(request) {
          return {
            ...request,
            planId: generation.planId,
            status: "ready",
            claimGeneration: 4,
            attemptCount: 1,
            contentHash: generation.planContentHash!
          };
        },
        async createCurrentGeneration() {
          throw new Error("characterized generation must already exist");
        },
        async loadCurrentGenerations() {
          return [generation];
        },
        async loadDueCurrentGenerations() {
          return [];
        },
        async claimMobCombatProfilesForZones() {
          return 1;
        },
        async updateCurrentGenerationReferences() {
          return 1;
        },
        async markGenerationExpired() {
          return generation;
        },
        async cleanupExpiredGeneration() {
          return false;
        },
        async loadReadyEntitiesForZones() {
          return entities;
        },
        async acquireRuntimeEntityLeases(requests, leaseMs) {
          leaseRequests.push(...requests);
          return requests.map((request) => ({
            ...request,
            fencingGeneration: 5,
            leaseExpiresAt: new Date(generatedAt.getTime() + leaseMs)
          }));
        },
        async renewRuntimeEntityLeases(leases) {
          return leases.map((lease) => ({
            entityId: lease.entityId,
            status: "renewed" as const
          }));
        },
        async rebindRuntimeEntityLease() {
          return null;
        },
        async releaseRuntimeEntityLeases(leases) {
          releasedLeases.push(...leases);
          return leases.length;
        }
      },
      planner,
      {
        spawnMob(input) {
          spawnedActors.push(input);
          return { entityId: input.entityId } as never;
        },
        despawnMob() {
          return true;
        },
        despawnPopulationManagedMob() {
          return false;
        },
        rebindPopulationAuthority() {
          return true;
        }
      },
      {
        regionCode: "c9e43f-fixture",
        runtimeSha: "c".repeat(40),
        worldEnvironmentIdentityKey:
          characterization.worldEnvironmentIdentityKey,
        worldPipelineSha: characterization.worldPipelineSha,
        runtimeLeaseMs: 30_000,
        runtimeHeartbeatMs: 10_000,
        generationSweepMs: 60_000
      }
    );

    try {
      const activation = await backend.activateZones({
        zoneIds: [zoneId],
        trigger: "world-entry",
        relocationRevision: 3,
        resourceVisionRevision: 4,
        priorityByZone: { [zoneId]: 0 },
        currentReferencesByZone: { [zoneId]: 1 },
        challengeProfilesByZone: {
          [zoneId]: {
            currentGearLevel: 15,
            unlockedGearLevel: 15,
            tier: "rare",
            contributors: { melee: 15, chest: 15, secondary: 15 },
            balanceVersion: 2
          }
        }
      });
      const backendSnapshot = backend.snapshot();
      const sleep = await backend.sleepZones({ zoneIds: [zoneId] });

      expect({
        activationDigest: digest(
          activation.map(legacyActivationForFixture) as unknown as CanonicalJsonValue
        ),
        leaseRequests: leaseRequests.map(leaseFence),
        spawnedActorsDigest: digest(
          spawnedActors.map(actorForFixture) as CanonicalJsonValue
        ),
        backendSnapshot: {
          activeRuntimeActors: backendSnapshot.activeRuntimeActors,
          activeRuntimeActorsByZone:
            backendSnapshot.activeRuntimeActorsByZone,
          materializationFastPathHits:
            backendSnapshot.materializationFastPathHits,
          materializationReconciliations:
            backendSnapshot.materializationReconciliations,
          currentGenerations: backendSnapshot.currentGenerations.map(
            (current) => ({
              zoneId: current.zoneId,
              generationId: current.generationId,
              generatedAtIso: current.generatedAtIso,
              expiresAtIso: current.expiresAtIso,
              status: current.status,
              plannedNonStoneCount: current.plannedNonStoneCount,
              activeNonStoneCount: current.activeNonStoneCount,
              currentReferenceCount: current.currentReferenceCount
            })
          )
        },
        sleep,
        releasedLeases: releasedLeases.map(leaseFence)
      }).toEqual(characterization.runtimeMapping);
    } finally {
      await backend.close();
    }
  });
});

function countsByKind(
  slots: readonly PopulationZoneV2PlanSlot[]
): Record<string, number> {
  return Object.fromEntries(KINDS.map((kind) => [
    kind,
    slots.filter((slot) => slot.entityKind === kind).length
  ]));
}

function slotsForDigest(
  slots: readonly PopulationZoneV2PlanSlot[]
): CanonicalJsonValue {
  return [...slots]
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .map((slot) => ({
      ...slot,
      environmentSnapshot: slot.environmentSnapshot
    })) as CanonicalJsonValue;
}

function runtimeMappingEntities(
  zoneId: string,
  generationId: string
): PopulationZoneV2ReadyEntity[] {
  const common = {
    planId: characterization.identity.planId,
    zoneId,
    cutoverRevision: 13,
    encounterId: null,
    packId: null,
    packMemberIndex: null,
    environmentSnapshot: { fixture: "c9e43f-runtime-mapping" },
    stateRevision: 7
  } as const;
  return [
    {
      ...common,
      generationId,
      slotId: "6957fc4f-5b6d-810d-a83b-1ab01395f685",
      entityId: "73664a26-a543-8ea7-a9b4-2c72f02ca393",
      entityKind: "wolf",
      archetype: "wolf",
      encounterId: "5abb1934-ad95-8898-8ea0-3961ca526148",
      packId: "bea08ba4-4502-8029-bbeb-4f378e150db4",
      packMemberIndex: 1,
      lat: 35.01888072,
      lon: -106.707061587,
      anchorLat: 35.018296167,
      anchorLon: -106.707061587,
      suppressionClass: "hostile-pack",
      combatLevel: 15,
      combatTier: "rare",
      combatBalanceVersion: 2,
      combatProfileSource: "zone_player_profile"
    },
    {
      ...common,
      generationId,
      slotId: "0f0957db-a8ba-824a-a914-f4fc927a03a3",
      entityId: "357509c3-d046-89e1-897d-9050e63ad1c3",
      entityKind: "tree",
      archetype: "giving_tree",
      lat: 35.016924735,
      lon: -106.706477715,
      anchorLat: 35.016924735,
      anchorLon: -106.706477715,
      suppressionClass: "none",
      stateRevision: 11,
      resinAvailable: true
    },
    {
      ...common,
      generationId: null,
      slotId: "64aee604-cb27-8a94-8d5a-bc1a93a276f9",
      entityId: "c9fe69eb-ee90-8c0f-ada3-00618d6f8233",
      entityKind: "stone",
      archetype: "stone_mine",
      lat: 35.024192726,
      lon: -106.707128318,
      anchorLat: 35.024192726,
      anchorLon: -106.707128318,
      suppressionClass: "none",
      stateRevision: 3
    }
  ];
}

function leaseFence(
  lease: PopulationZoneV2RuntimeLeaseRequest | PopulationZoneV2RuntimeLease
) {
  return {
    entityId: lease.entityId,
    cutoverRevision: lease.cutoverRevision,
    stateRevision: lease.stateRevision,
    ...("fencingGeneration" in lease
      ? { fencingGeneration: lease.fencingGeneration }
      : {})
  };
}

function legacyActivationForFixture(
  activation: Awaited<
    ReturnType<PopulationZonesV2Backend["activateZones"]>
  >[number]
) {
  return {
    zoneId: activation.zoneId,
    generationId: activation.generationId,
    generationExpiresAtMs: activation.generationExpiresAtMs,
    status: activation.status,
    materializationStatus: activation.materializationStatus,
    entities: activation.entities,
    removedEntityIds: activation.removedEntityIds,
    spawnedRuntimeActors: activation.spawnedRuntimeActors
  };
}

function actorForFixture(value: unknown) {
  const actor = value as Readonly<{
    entityId: string;
    archetype: string;
    position: unknown;
    homePosition: unknown;
    populationCellId: string;
    packId: string | null;
    lifeGeneration: number;
    populationAuthority: Readonly<{
      fencingGeneration: number;
      cutoverRevision: number;
    }>;
    worldAi: boolean;
    regionCode: string;
    zoneId: string;
    originFlagId: null;
  }>;
  return {
    entityId: actor.entityId,
    archetype: actor.archetype,
    position: actor.position,
    homePosition: actor.homePosition,
    populationCellId: actor.populationCellId,
    packId: actor.packId,
    lifeGeneration: actor.lifeGeneration,
    populationAuthority: {
      fencingGeneration: actor.populationAuthority.fencingGeneration,
      cutoverRevision: actor.populationAuthority.cutoverRevision
    },
    worldAi: actor.worldAi,
    regionCode: actor.regionCode,
    zoneId: actor.zoneId,
    originFlagId: actor.originFlagId
  };
}

function digest(value: CanonicalJsonValue): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}
