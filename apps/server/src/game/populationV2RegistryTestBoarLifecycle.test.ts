import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createPopulationV2MobRegistry,
  createSinglePopulationV2MobCandidateBuilder,
  populationV2MobRegistry,
  type PopulationV2MobDefinition
} from "./populationV2MobRegistry.js";
import { planPopulationV2RegisteredMobOverlay } from "./populationV2RegisteredMobOverlay.js";
import { PopulationZonesV2Backend } from "./populationZonesV2Backend.js";
import {
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  generatePopulationZoneV2GenerationSlots,
  type PopulationZoneV2Habitat
} from "./populationZonesV2Plan.js";
import type { PopulationZonesV2Planner } from "./populationZonesV2Planner.js";
import {
  POPULATION_GENERATION_MATERIALIZATION_REVISION,
  PostgresPopulationZonesV2Store,
  populationV2ProjectionRowForSlot,
  type PopulationZoneV2GenerationRecord,
  type PopulationZoneV2ReadyEntity,
  type PopulationZoneV2RuntimeLease,
  type PopulationZoneV2RuntimeLeaseRequest
} from "./populationZonesV2Store.js";
import type { PopulationZonesV2RuntimeBackend } from "./populationZonesV2Runtime.js";

const POSITION = { lat: 39.7392, lon: -104.9903 };
const ZONE_ID = populationZoneV2IdForPoint(POSITION);
const PLAN_ID = "10000000-0000-8000-8000-000000000010";
const GENERATION_ID = "10000000-0000-8000-8000-000000000011";
const ANCHOR_SITE_ID = "registry-test-boar-anchor";

const BOAR_DEFINITION = {
  mobKind: "registry_test_boar",
  combatArchetype: "deer",
  placementRevision: "registry-test-boar-placement-v1",
  generationPlacement: "registered_overlay",
  spawnModel: "single",
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  plannerPriority: 100,
  density: {
    model: "rare",
    targetAreaKm2: 1,
    candidateOversamplingFactor: 1
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.eligibleLandKm2,
  isEligibleAnchor: (site) => site.weights.eligibleLand > 0,
  candidateBuilder:
    createSinglePopulationV2MobCandidateBuilder("registry_test_boar"),
  spacingClass: "passive_single",
  suppressionClass: "deer-safe",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Registry test boar"
} as const satisfies PopulationV2MobDefinition<
  "registry_test_boar",
  "deer"
>;

const boarRegistry = createPopulationV2MobRegistry([BOAR_DEFINITION]);

describe("Population V2 injected mob lifecycle", () => {
  it("carries a test-only boar through planning, projection, leases, and runtime fencing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    const overlay = planPopulationV2RegisteredMobOverlay({
      generationId: GENERATION_ID,
      habitat: boarHabitat(),
      occupiedSlots: [],
      registry: boarRegistry
    });
    const slot = overlay.slots[0]!;
    const identity = boarRegistry.registeredIdentityFor({
      generationId: GENERATION_ID,
      mobKind: "registry_test_boar",
      deterministicCandidateId: ANCHOR_SITE_ID
    });

    expect(overlay).toMatchObject({
      status: "completed",
      target: { groups: 1, bodies: 1 },
      inserted: { groups: 1, bodies: 1 },
      shortfall: { groups: 0, bodies: 0 }
    });
    expect(slot).toMatchObject({
      slotId: identity.slotId,
      entityId: identity.entityId,
      candidateId: identity.candidateId,
      entityKind: "registry_test_boar",
      archetype: "deer",
      packId: null,
      packMemberIndex: null,
      sourceAnchorSiteId: ANCHOR_SITE_ID
    });
    expect(populationV2ProjectionRowForSlot({
      slot,
      regionCode: "registry-test",
      defaultPlacementVersion: "legacy-global-layout",
      registeredPlacementRevision: BOAR_DEFINITION.placementRevision
    })).toMatchObject({
      entity_kind: "registry_test_boar",
      archetype: "deer",
      placement_version: "registry-test-boar-placement-v1"
    });

    let durableState: "ready" | "dead" = "ready";
    let cutoverRevision = 1;
    const projectionQuery = vi.fn(async (sql: string) => {
      void sql;
      return {
        rows: durableState === "ready"
          ? [projectionRow(slot, cutoverRevision)]
          : [],
        rowCount: durableState === "ready" ? 1 : 0
      };
    });
    const projectionStore = new PostgresPopulationZonesV2Store(
      { query: projectionQuery } as unknown as pg.Pool,
      generatePopulationZoneV2GenerationSlots,
      boarRegistry
    );
    const projected = await projectionStore.loadReadyEntitiesForZones([
      ZONE_ID
    ]);
    expect(projected).toHaveLength(1);
    expect(String(projected[0]!.entityKind)).toBe("registry_test_boar");
    expect(projected[0]).toMatchObject({
      entityId: slot.entityId,
      generationId: GENERATION_ID,
      archetype: "deer",
      stateRevision: 0
    });
    expect(projectionQuery.mock.calls[0]![0]).toContain(
      "JOIN population_entity_state_v2 AS state"
    );
    expect(projectionQuery.mock.calls[0]![0]).toContain(
      "state.state='ready'"
    );

    const generation = generationRecord();
    const acquired: PopulationZoneV2RuntimeLeaseRequest[][] = [];
    const released: PopulationZoneV2RuntimeLease[][] = [];
    let fencingGeneration = 0;
    const store = {
      ensurePlanForZone: vi.fn(async (): Promise<never> => {
        throw new Error("valid current generation must not prepare a plan");
      }),
      createCurrentGeneration: vi.fn(async (): Promise<never> => {
        throw new Error("valid current generation must not be recreated");
      }),
      loadCurrentGenerations: vi.fn(async () => [generation]),
      claimMobCombatProfilesForZones: vi.fn(async () => 0),
      loadDueCurrentGenerations: vi.fn(async () => []),
      updateCurrentGenerationReferences: vi.fn(async () => 1),
      markGenerationExpired: vi.fn(async () => generation),
      cleanupExpiredGeneration: vi.fn(async () => false),
      loadReadyEntitiesForZones: vi.fn(async (
        zoneIds: readonly string[]
      ): Promise<PopulationZoneV2ReadyEntity[]> =>
        projectionStore.loadReadyEntitiesForZones(zoneIds)
      ),
      acquireRuntimeEntityLeases: vi.fn(async (
        requests: readonly PopulationZoneV2RuntimeLeaseRequest[],
        leaseMs: number
      ) => {
        acquired.push([...requests]);
        if (durableState !== "ready") return [];
        return requests
          .filter((request) => request.cutoverRevision === cutoverRevision)
          .map((request) => ({
            ...request,
            fencingGeneration: ++fencingGeneration,
            leaseExpiresAt: new Date(Date.now() + leaseMs)
          }));
      }),
      renewRuntimeEntityLeases: vi.fn(async (
        leases: readonly PopulationZoneV2RuntimeLease[]
      ) => leases.map((lease) => ({
        entityId: lease.entityId,
        status: durableState !== "ready"
          ? "durable-state-no-longer-ready" as const
          : lease.cutoverRevision !== cutoverRevision
            ? "actual-cutover" as const
            : "renewed" as const
      }))),
      rebindRuntimeEntityLease: vi.fn(async (
        existing: PopulationZoneV2RuntimeLease,
        request: PopulationZoneV2RuntimeLeaseRequest,
        leaseMs: number
      ) => durableState === "ready"
        && request.cutoverRevision === cutoverRevision
        ? {
            ...request,
            fencingGeneration: existing.fencingGeneration + 1,
            leaseExpiresAt: new Date(Date.now() + leaseMs)
          }
        : null
      ),
      releaseRuntimeEntityLeases: vi.fn(async (
        leases: readonly PopulationZoneV2RuntimeLease[]
      ) => {
        released.push([...leases]);
        return leases.length;
      })
    };
    const combat = {
      spawnMob: vi.fn((input: { entityId?: string }) =>
        ({ entityId: input.entityId ?? slot.entityId } as never)
      ),
      despawnMob: vi.fn(() => true),
      despawnPopulationManagedMob: vi.fn(() => false),
      rebindPopulationAuthority: vi.fn(() => true)
    };
    const planner = readyPlanner();
    const backend = new PopulationZonesV2Backend(
      store,
      planner,
      combat,
      {
        regionCode: "registry-test",
        runtimeSha: "c".repeat(40),
        worldEnvironmentIdentityKey: "a".repeat(64),
        worldPipelineSha: "b".repeat(40),
        runtimeLeaseMs: 100,
        runtimeHeartbeatMs: 10,
        generationSweepMs: 1_000_000,
        mobRegistry: boarRegistry
      }
    );
    const runtimeBackend: PopulationZonesV2RuntimeBackend = backend;

    try {
      const first = await runtimeBackend.activateZones(activation());
      expect(first[0]).toMatchObject({
        status: "ready",
        spawnedRuntimeActors: 1,
        entities: [{
          entityId: slot.entityId,
          kind: "registry_test_boar",
          archetype: "deer",
          stateRevision: 0
        }]
      });
      expect(acquired).toHaveLength(1);
      expect(acquired[0]).toEqual([expect.objectContaining({
        entityId: slot.entityId,
        cutoverRevision: 1,
        stateRevision: 0
      })]);
      expect(combat.spawnMob).toHaveBeenCalledWith(expect.objectContaining({
        entityId: slot.entityId,
        archetype: "deer",
        lifeGeneration: 0,
        worldAi: true,
        populationAuthority: expect.objectContaining({
          cutoverRevision: 1,
          fencingGeneration: 1
        })
      }));

      await runtimeBackend.activateZones(activation());
      expect(store.acquireRuntimeEntityLeases).toHaveBeenCalledOnce();
      expect(combat.spawnMob).toHaveBeenCalledOnce();
      expect(backend.snapshot().deduplicatedRuntimeActivations).toBe(1);

      cutoverRevision = 2;
      await runtimeBackend.activateZones(activation());
      expect(store.rebindRuntimeEntityLease).toHaveBeenCalledOnce();
      expect(combat.rebindPopulationAuthority).toHaveBeenCalledWith(
        slot.entityId,
        expect.objectContaining({
          cutoverRevision: 2,
          fencingGeneration: 2
        })
      );
      expect(combat.spawnMob).toHaveBeenCalledOnce();
      expect(backend.snapshot().actorInPlaceRebinds).toBe(1);

      const sleep = await runtimeBackend.sleepZones({
        zoneIds: [ZONE_ID]
      });
      expect(sleep).toEqual({
        removedEntityIds: [slot.entityId],
        sleptRuntimeActors: 1
      });
      expect(released.at(-1)).toEqual([expect.objectContaining({
        entityId: slot.entityId,
        cutoverRevision: 2
      })]);

      const wake = await runtimeBackend.activateZones(activation());
      expect(wake[0]!.spawnedRuntimeActors).toBe(1);
      expect(combat.spawnMob).toHaveBeenCalledTimes(2);

      cutoverRevision = 3;
      await vi.advanceTimersByTimeAsync(10);
      expect(store.renewRuntimeEntityLeases).toHaveBeenLastCalledWith(
        [expect.objectContaining({
          entityId: slot.entityId,
          cutoverRevision: 2
        })],
        100
      );
      expect(backend.snapshot().activeRuntimeActors).toBe(0);

      const afterCutover = await runtimeBackend.activateZones(activation());
      expect(afterCutover[0]!.spawnedRuntimeActors).toBe(1);
      expect(combat.spawnMob).toHaveBeenCalledTimes(3);

      durableState = "dead";
      const dead = await runtimeBackend.activateZones(activation());
      expect(dead[0]).toMatchObject({
        entities: [],
        removedEntityIds: [slot.entityId],
        spawnedRuntimeActors: 0
      });
      expect(backend.snapshot().activeRuntimeActors).toBe(0);

      const deadWake = await runtimeBackend.activateZones(activation());
      expect(deadWake[0]).toMatchObject({
        entities: [],
        spawnedRuntimeActors: 0
      });
      expect(combat.spawnMob).toHaveBeenCalledTimes(3);
      expect(backend.snapshot()).toMatchObject({
        activeRuntimeActors: 0,
        mobDespawnsByReason: {
          "actual-plan-cutover": 1,
          "durable-state-no-longer-ready": 1,
          "left-authoritative-visibility": 1
        }
      });
    } finally {
      await backend.close();
      vi.useRealTimers();
    }
  });
});

describe("Population V2 production registry lifecycle acceptance", () => {
  for (const definition of populationV2MobRegistry.definitions) {
    it(`${definition.mobKind}: ready through durable death and cutover fencing`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
      try {
        const harness = productionMobLifecycleHarness(definition);
        const backend = harness.createBackend();

        try {
          const first = await backend.activateZones(activation());
          expect(first[0]).toMatchObject({
            status: "ready",
            spawnedRuntimeActors: 1,
            entities: [{
              entityId: harness.entity.entityId,
              kind: definition.mobKind,
              archetype: definition.combatArchetype,
              stateRevision: 0
            }]
          });
          expect(harness.store.acquireRuntimeEntityLeases)
            .toHaveBeenCalledWith(
              [expect.objectContaining({
                entityId: harness.entity.entityId,
                cutoverRevision: 1,
                stateRevision: 0
              })],
              100
            );
          expect(harness.combat.spawnMob).toHaveBeenCalledWith(
            expect.objectContaining({
              entityId: harness.entity.entityId,
              archetype: definition.combatArchetype,
              lifeGeneration: 0,
              worldAi: true,
              populationAuthority: expect.objectContaining({
                cutoverRevision: 1,
                fencingGeneration: 1
              })
            })
          );

          await backend.activateZones(activation());
          expect(harness.store.acquireRuntimeEntityLeases)
            .toHaveBeenCalledOnce();
          expect(harness.combat.spawnMob).toHaveBeenCalledOnce();
          expect(backend.snapshot().deduplicatedRuntimeActivations).toBe(1);

          harness.cutoverRevision.value = 2;
          await backend.activateZones(activation());
          expect(harness.store.rebindRuntimeEntityLease).toHaveBeenCalledOnce();
          expect(harness.combat.rebindPopulationAuthority)
            .toHaveBeenCalledWith(
              harness.entity.entityId,
              expect.objectContaining({
                cutoverRevision: 2,
                fencingGeneration: 2
              })
            );
          expect(harness.combat.spawnMob).toHaveBeenCalledOnce();

          await backend.sleepZones({ zoneIds: [ZONE_ID] });
          const wake = await backend.activateZones(activation());
          expect(wake[0]!.spawnedRuntimeActors).toBe(1);
          expect(harness.combat.spawnMob).toHaveBeenCalledTimes(2);

          harness.durableState.value = "dead";
          harness.cutoverRevision.value = 3;
          await vi.advanceTimersByTimeAsync(10);
          expect(harness.store.renewRuntimeEntityLeases)
            .toHaveBeenLastCalledWith(
              [expect.objectContaining({
                entityId: harness.entity.entityId,
                cutoverRevision: 2
              })],
              100
            );
          expect(backend.snapshot()).toMatchObject({
            activeRuntimeActors: 0,
            mobDespawnsByReason: { "actual-plan-cutover": 1 }
          });

          const dead = await backend.activateZones(activation());
          expect(dead[0]).toMatchObject({
            entities: [],
            spawnedRuntimeActors: 0
          });
          await backend.sleepZones({ zoneIds: [ZONE_ID] });
          const deadWake = await backend.activateZones(activation());
          expect(deadWake[0]).toMatchObject({
            entities: [],
            spawnedRuntimeActors: 0
          });
          expect(harness.combat.spawnMob).toHaveBeenCalledTimes(2);
        } finally {
          await backend.close();
        }

        const restarted = harness.createBackend();
        try {
          const reactivated = await restarted.activateZones(activation());
          expect(reactivated[0]).toMatchObject({
            entities: [],
            spawnedRuntimeActors: 0
          });
          expect(harness.combat.spawnMob).toHaveBeenCalledTimes(2);
          expect(harness.store.acquireRuntimeEntityLeases)
            .toHaveBeenCalledTimes(2);
        } finally {
          await restarted.close();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

type ProductionMobDefinition =
  (typeof populationV2MobRegistry.definitions)[number];

function productionMobLifecycleHarness(
  definition: ProductionMobDefinition
) {
  const identity = populationV2MobRegistry.registeredIdentityFor({
    generationId: GENERATION_ID,
    mobKind: definition.mobKind,
    deterministicCandidateId:
      `production-lifecycle-${definition.mobKind}`,
    ...(definition.spawnModel === "pack" ? { memberIndex: 0 } : {})
  });
  const entity: PopulationZoneV2ReadyEntity = {
    planId: PLAN_ID,
    zoneId: ZONE_ID,
    generationId: GENERATION_ID,
    cutoverRevision: 1,
    slotId: identity.slotId,
    entityId: identity.entityId,
    entityKind: definition.mobKind,
    archetype: definition.combatArchetype,
    encounterId: identity.encounterId,
    packId: identity.packId,
    packMemberIndex: identity.memberIndex,
    lat: POSITION.lat,
    lon: POSITION.lon,
    anchorLat: POSITION.lat,
    anchorLon: POSITION.lon,
    environmentSnapshot: {},
    suppressionClass: definition.suppressionClass,
    stateRevision: 0,
    combatLevel: 12,
    combatTier: "rare",
    combatBalanceVersion: 2
  };
  const durableState = { value: "ready" as "ready" | "dead" };
  const cutoverRevision = { value: 1 };
  let fencingGeneration = 0;
  const generation = generationRecord();
  const store = {
    ensurePlanForZone: vi.fn(async (): Promise<never> => {
      throw new Error("valid current generation must not prepare a plan");
    }),
    createCurrentGeneration: vi.fn(async (): Promise<never> => {
      throw new Error("valid current generation must not be recreated");
    }),
    loadCurrentGenerations: vi.fn(async () => [generation]),
    claimMobCombatProfilesForZones: vi.fn(async () => 0),
    loadDueCurrentGenerations: vi.fn(async () => []),
    updateCurrentGenerationReferences: vi.fn(async () => 1),
    markGenerationExpired: vi.fn(async () => generation),
    cleanupExpiredGeneration: vi.fn(async () => false),
    loadReadyEntitiesForZones: vi.fn(async (
      zoneIds: readonly string[]
    ): Promise<PopulationZoneV2ReadyEntity[]> => {
      void zoneIds;
      return durableState.value === "ready"
        ? [{ ...entity, cutoverRevision: cutoverRevision.value }]
        : [];
    }),
    acquireRuntimeEntityLeases: vi.fn(async (
      requests: readonly PopulationZoneV2RuntimeLeaseRequest[],
      leaseMs: number
    ) => durableState.value === "ready"
      ? requests
          .filter((request) =>
            request.cutoverRevision === cutoverRevision.value
          )
          .map((request) => ({
            ...request,
            fencingGeneration: ++fencingGeneration,
            leaseExpiresAt: new Date(Date.now() + leaseMs)
          }))
      : []),
    renewRuntimeEntityLeases: vi.fn(async (
      leases: readonly PopulationZoneV2RuntimeLease[]
    ) => leases.map((lease) => ({
      entityId: lease.entityId,
      status: lease.cutoverRevision !== cutoverRevision.value
        ? "actual-cutover" as const
        : durableState.value !== "ready"
          ? "durable-state-no-longer-ready" as const
          : "renewed" as const
    }))),
    rebindRuntimeEntityLease: vi.fn(async (
      existing: PopulationZoneV2RuntimeLease,
      request: PopulationZoneV2RuntimeLeaseRequest,
      leaseMs: number
    ) => durableState.value === "ready"
      && request.cutoverRevision === cutoverRevision.value
      ? {
          ...request,
          fencingGeneration: existing.fencingGeneration + 1,
          leaseExpiresAt: new Date(Date.now() + leaseMs)
        }
      : null),
    releaseRuntimeEntityLeases: vi.fn(async (
      leases: readonly PopulationZoneV2RuntimeLease[]
    ) => leases.length)
  };
  const combat = {
    spawnMob: vi.fn((input: { entityId?: string }) =>
      ({ entityId: input.entityId ?? entity.entityId } as never)
    ),
    despawnMob: vi.fn(() => true),
    despawnPopulationManagedMob: vi.fn(() => false),
    rebindPopulationAuthority: vi.fn(() => true)
  };

  return {
    combat,
    cutoverRevision,
    durableState,
    entity,
    store,
    createBackend: () => new PopulationZonesV2Backend(
      store,
      readyPlanner(),
      combat,
      {
        regionCode: "registry-test",
        runtimeSha: "c".repeat(40),
        worldEnvironmentIdentityKey: "a".repeat(64),
        worldPipelineSha: "b".repeat(40),
        runtimeLeaseMs: 100,
        runtimeHeartbeatMs: 10,
        generationSweepMs: 1_000_000,
        mobRegistry: populationV2MobRegistry
      }
    )
  };
}

function boarHabitat(): PopulationZoneV2Habitat {
  return {
    regionCode: "registry-test",
    eligibleLandKm2: 1,
    treeKm2: 1,
    deerKm2: 1,
    wolfKm2: 1,
    stoneKm2: 1,
    ogreKm2: 1,
    habitatSummary: {},
    environmentSnapshot: {},
    candidateSites: [{
      siteId: ANCHOR_SITE_ID,
      position: POSITION,
      source: "world-profile-candidate-slot",
      sourceSampleId: "registry-test-sample",
      sourceCellId: "registry-test-cell",
      sourceSlotId: "registry-test-slot",
      candidateSlotVersion: "registry-test-candidates-v1",
      placementTags: ["flat-anchor"],
      isSaltwater: false,
      insideMajorLake: false,
      elevationBand: "low",
      terrainClass: "flat",
      landCoverClass: "grassland",
      biomeId: "registry-test-biome",
      ecoregionId: "registry-test-ecoregion",
      spawnProfileKey: "registry-test",
      weights: {
        eligibleLand: 1,
        tree: 1,
        deer: 1,
        wolf: 1,
        stone: 1,
        ogre: 1
      }
    }]
  };
}

function projectionRow(
  slot: ReturnType<
    typeof planPopulationV2RegisteredMobOverlay
  >["slots"][number],
  cutoverRevision: number
) {
  return {
    plan_id: PLAN_ID,
    zone_id: ZONE_ID,
    generation_id: GENERATION_ID,
    cutover_revision: cutoverRevision,
    slot_id: slot.slotId,
    entity_id: slot.entityId,
    entity_kind: slot.entityKind,
    archetype: slot.archetype,
    encounter_id: slot.encounterId,
    pack_id: slot.packId,
    pack_member_index: slot.packMemberIndex,
    latitude: slot.position.lat,
    longitude: slot.position.lon,
    anchor_latitude: slot.anchor.lat,
    anchor_longitude: slot.anchor.lon,
    environment_snapshot: slot.environmentSnapshot,
    suppression_class: slot.suppressionClass,
    state_revision: 0,
    combat_level: 12,
    combat_tier: "rare",
    combat_balance_version: 2,
    resin_harvested_life_revision: null
  };
}

function generationRecord(): PopulationZoneV2GenerationRecord {
  const generatedAt = new Date("2098-12-31T23:00:00.000Z");
  return {
    generationId: GENERATION_ID,
    zoneId: ZONE_ID,
    planId: PLAN_ID,
    generationNumber: 1,
    generatedAt,
    expiresAt: new Date("2099-01-03T00:00:00.000Z"),
    status: "active",
    plannedNonStoneCount: 1,
    currentReferenceCount: 1,
    unreferencedAt: null,
    isCurrent: true,
    cleanedAt: null,
    materializationRevision:
      POPULATION_GENERATION_MATERIALIZATION_REVISION
  };
}

function readyPlanner(): Pick<
  PopulationZonesV2Planner,
  "scheduleZones" | "scheduleZonesAndWait"
> {
  return {
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
}

function activation() {
  return {
    zoneIds: [ZONE_ID] as readonly PopulationZoneV2Id[],
    trigger: "world-entry" as const,
    relocationRevision: 1,
    resourceVisionRevision: 1,
    priorityByZone: { [ZONE_ID]: 0 as const },
    currentReferencesByZone: { [ZONE_ID]: 1 },
    challengeProfilesByZone: { [ZONE_ID]: {
      balanceVersion: 2 as const, currentGearLevel: 12, unlockedGearLevel: 12,
      tier: "rare" as const, contributors: { melee: 12, chest: 12, secondary: 12 }
    } }
  };
}
