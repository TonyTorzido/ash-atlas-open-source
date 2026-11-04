import { describe, expect, it, vi } from "vitest";
import {
  mobChallengeTier,
  POPULATION_DENSITY_REVISION
} from "@ash-atlas/shared";

import { populationZoneV2IdForPoint } from "./populationZonesV2Geometry.js";
import { POPULATION_CANDIDATE_LAYOUT_VERSION } from "./populationZonesV2Identity.js";
import type { PopulationZonesV2Planner } from "./populationZonesV2Planner.js";
import type { PopulationMobCombatRuntimeState } from "./combat/combatEngine.js";
import { PopulationZonesV2Backend } from "./populationZonesV2Backend.js";
import { POPULATION_GENERATION_MATERIALIZATION_REVISION } from "./populationZonesV2Store.js";
import type {
  PopulationZoneV2GenerationRecord,
  PopulationZoneV2PlanRequest,
  PopulationZoneV2ReadyEntity,
  PopulationZoneV2RuntimeLeaseRequest
} from "./populationZonesV2Store.js";

const ZONE_ID = populationZoneV2IdForPoint({
  lat: 39.7392,
  lon: -104.9903
});
const PLAN_ID = "00000000-0000-4000-8000-000000000010";
const GENERATION_ID = "00000000-0000-4000-8000-000000000011";
const NEXT_GENERATION_ID = "00000000-0000-4000-8000-000000000012";
const ENTITY_ID = "00000000-0000-4000-8000-000000000020";
const STONE_ID = "00000000-0000-4000-8000-000000000021";
const EXTRA_ENTITY_ID = "00000000-0000-4000-8000-000000000022";
const OBSOLETE_ENTITY_ID = "00000000-0000-4000-8000-000000000023";
const NEXT_ENTITY_ID = "00000000-0000-4000-8000-000000000025";
const OTHER_GENERATION_ID = "00000000-0000-4000-8000-000000000013";
const OTHER_ENTITY_ID = "00000000-0000-4000-8000-000000000024";
const OTHER_ZONE_ID = populationZoneV2IdForPoint({
  lat: 40.7608,
  lon: -111.891
});
const THIRD_ZONE_ID = populationZoneV2IdForPoint({
  lat: 36.1627,
  lon: -86.7816
});

describe("PopulationZonesV2Backend", () => {
  it("delegates environment prefetch without entering activation or materialization", async () => {
    const harness = createHarness();
    const controller = new AbortController();

    await harness.backend.prefetchPlanEnvironmentForZones({
      zoneIds: [ZONE_ID, OTHER_ZONE_ID],
      trigger: "flag-travel",
      priority: 0,
      signal: controller.signal
    });

    expect(harness.planner.prefetchEnvironmentForZones).toHaveBeenCalledWith({
      zoneIds: [ZONE_ID, OTHER_ZONE_ID],
      regionCode: "test",
      reason: "flag-travel",
      priority: 0,
      signal: controller.signal
    });
    expect(harness.planner.scheduleZones).not.toHaveBeenCalled();
    expect(harness.planner.scheduleZonesAndWait).not.toHaveBeenCalled();
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    expect(harness.store.loadReadyEntitiesForZones).not.toHaveBeenCalled();
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("keeps priority 2 as immutable habitat/template preparation only", async () => {
    const harness = createHarness();

    const result = await harness.backend.activateZones(activation(2));

    expect(result).toEqual([expect.objectContaining({
      zoneId: ZONE_ID,
      generationId: null,
      generationExpiresAtMs: null,
      materializationStatus: "generation-missing",
      status: "ready",
      entities: [],
      removedEntityIds: [],
      spawnedRuntimeActors: 0,
      completedStage: "PLAN_READY",
      reason: "ready"
    })]);
    expect(harness.planner.scheduleZones).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 2 })
    );
    expect(harness.store.ensurePlanForZone).toHaveBeenCalledOnce();
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    expect(harness.store.loadReadyEntitiesForZones).not.toHaveBeenCalled();
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("preserves terminal plan failure when no generation can be materialized", async () => {
    const harness = createHarness();
    harness.planner.scheduleZonesAndWait.mockImplementation(async (input) => ({
      disabled: false,
      readyZoneIds: [],
      pendingZoneIds: [],
      terminalFailureZoneIds: input.zoneIds
    }));

    const result = await harness.backend.activateZones(activation(0));

    expect(result[0]).toMatchObject({
      zoneId: ZONE_ID,
      generationId: null,
      materializationStatus: "generation-missing",
      status: "pending",
      reason: "plan-terminal-failure"
    });
    await harness.backend.close();
  });

  it("reports each completed zone before the slowest scheduled zone settles", async () => {
    const harness = createHarness();
    let releaseOther!: () => void;
    const otherBlocked = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    harness.planner.scheduleZones.mockImplementation(async (input) => {
      if (input.zoneIds.includes(OTHER_ZONE_ID)) await otherBlocked;
      return {
        disabled: false,
        readyZoneIds: input.zoneIds,
        pendingZoneIds: []
      };
    });
    const completedZoneIds: string[] = [];
    let batchSettled = false;

    const activationPromise = harness.backend.activateZones({
      ...activation(2),
      zoneIds: [OTHER_ZONE_ID, ZONE_ID],
      priorityByZone: { [ZONE_ID]: 2, [OTHER_ZONE_ID]: 2 },
      targetStageByZone: {
        [ZONE_ID]: "PLAN_READY",
        [OTHER_ZONE_ID]: "PLAN_READY"
      },
      activationOrderByZone: { [ZONE_ID]: 0, [OTHER_ZONE_ID]: 1 },
      onZoneActivated: (result) => completedZoneIds.push(result.zoneId)
    });
    void activationPromise.then(() => {
      batchSettled = true;
    });

    await vi.waitFor(() => expect(completedZoneIds).toEqual([ZONE_ID]));
    expect(batchSettled).toBe(false);
    releaseOther();
    await expect(activationPromise).resolves.toHaveLength(2);
    expect(completedZoneIds).toEqual([ZONE_ID, OTHER_ZONE_ID]);
    await harness.backend.close();
  });

  it("finishes activation order zero before admitting other visible zones", async () => {
    const harness = createHarness();
    let releaseDestination!: () => void;
    const destinationBlocked = new Promise<void>((resolve) => {
      releaseDestination = resolve;
    });
    const startedZoneIds: string[] = [];
    harness.planner.scheduleZonesAndWait.mockImplementation(async (input) => {
      startedZoneIds.push(...input.zoneIds);
      if (input.zoneIds.includes(ZONE_ID)) await destinationBlocked;
      return {
        disabled: false,
        readyZoneIds: input.zoneIds,
        pendingZoneIds: []
      };
    });
    const completedZoneIds: string[] = [];

    const activationPromise = harness.backend.activateZones({
      ...activation(0, null),
      zoneIds: [OTHER_ZONE_ID, ZONE_ID],
      priorityByZone: { [ZONE_ID]: 0, [OTHER_ZONE_ID]: 0 },
      targetStageByZone: {
        [ZONE_ID]: "PLAN_READY",
        [OTHER_ZONE_ID]: "PLAN_READY"
      },
      activationOrderByZone: { [ZONE_ID]: 0, [OTHER_ZONE_ID]: 1 },
      onZoneActivated: (result) => completedZoneIds.push(result.zoneId)
    });

    await vi.waitFor(() => expect(startedZoneIds).toEqual([ZONE_ID]));
    expect(completedZoneIds).toEqual([]);
    releaseDestination();
    await expect(activationPromise).resolves.toHaveLength(2);
    expect(startedZoneIds).toEqual([ZONE_ID, OTHER_ZONE_ID]);
    expect(completedZoneIds).toEqual([ZONE_ID, OTHER_ZONE_ID]);
    await harness.backend.close();
  });

  it("materializes priority 1 asleep without acquiring leases or starting AI", async () => {
    const harness = createHarness();

    const result = await harness.backend.activateZones(activation(1));

    expect(harness.store.createCurrentGeneration).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      planId: PLAN_ID,
      now: expect.any(Date),
      currentReferences: 0
    });
    expect(harness.planner.scheduleZonesAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 1 })
    );
    expect(result[0]).toMatchObject({
      generationId: GENERATION_ID,
      status: "ready",
      spawnedRuntimeActors: 0,
      entities: [
        expect.objectContaining({
          entityId: ENTITY_ID,
          generationId: GENERATION_ID
        }),
        expect.objectContaining({
          entityId: STONE_ID,
          generationId: null
        })
      ]
    });
    expect(harness.store.acquireRuntimeEntityLeases).not.toHaveBeenCalled();
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("uses target stage and foreground authority for runtime activation", async () => {
    const durable = createHarness();
    const durableResult = await durable.backend.activateZones({
      ...activation(0),
      targetStageByZone: { [ZONE_ID]: "DURABLE_READY" }
    });
    expect(durableResult[0]).toMatchObject({
      status: "ready",
      completedStage: "DURABLE_READY",
      reason: "initial-world-generation",
      authority: {
        zoneId: ZONE_ID,
        selectedPlanId: PLAN_ID,
        generationId: GENERATION_ID,
        commonSchemaRevision: "population-common-schema-v2-encounter-identity",
        registryRevision: expect.stringMatching(
          /^population-kind-registry-v2:[a-f0-9]{16}$/u
        )
      }
    });
    expect(durable.store.acquireRuntimeEntityLeases).not.toHaveBeenCalled();
    expect(durable.combat.spawnMob).not.toHaveBeenCalled();
    await durable.backend.close();

    const simulation = createHarness();
    const simulationResult = await simulation.backend.activateZones({
      ...activation(0),
      targetStageByZone: { [ZONE_ID]: "SIMULATION_READY" }
    });
    expect(simulationResult[0]).toMatchObject({
      status: "ready",
      completedStage: "SIMULATION_READY"
    });
    expect(simulation.store.acquireRuntimeEntityLeases).toHaveBeenCalledOnce();
    expect(simulation.combat.spawnMob).toHaveBeenCalledOnce();
    await simulation.backend.close();
  });

  it("reuses matching durable descriptors for profile-free durable work", async () => {
    const harness = createHarness();
    const durable = await harness.backend.activateZones({
      ...activation(1),
      targetStageByZone: { [ZONE_ID]: "DURABLE_READY" }
    });
    const authority = durable[0]?.authority;
    expect(authority).toBeTruthy();
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    harness.store.loadReadyEntitiesForZones.mockClear();

    const reused = await harness.backend.activateZones({
      ...activation(1),
      targetStageByZone: { [ZONE_ID]: "DURABLE_READY" },
      preparedAuthoritiesByZone: { [ZONE_ID]: authority! }
    });

    expect(reused[0]).toMatchObject({
      status: "ready",
      completedStage: "DURABLE_READY",
      authority
    });
    expect(harness.store.loadReadyEntitiesForZones).not.toHaveBeenCalled();
    expect(harness.store.acquireRuntimeEntityLeases).not.toHaveBeenCalled();
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("reloads a background-prepared durable cache after the first player profile claim", async () => {
    const harness = createHarness();

    const preloaded = await harness.backend.activateZones(activation(1));
    expect(preloaded[0]).toMatchObject({
      generationId: GENERATION_ID,
      spawnedRuntimeActors: 0
    });
    expect(preloaded[0]!.entities.find(
      (entity) => entity.entityId === ENTITY_ID
    )?.combatLevel).toBeUndefined();
    expect(preloaded[0]!.authority).not.toBeNull();
    expect(harness.store.claimMobCombatProfilesForZones).not.toHaveBeenCalled();
    expect(harness.store.loadReadyEntitiesForZones).toHaveBeenCalledOnce();
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    expect(harness.store.acquireRuntimeEntityLeases).not.toHaveBeenCalled();

    const arrived = await harness.backend.activateZones({
      ...activation(0, challengeProfile(7)),
      preparedAuthoritiesByZone: {
        [ZONE_ID]: preloaded[0]!.authority!
      }
    });
    expect(arrived[0]).toMatchObject({
      generationId: GENERATION_ID,
      status: "ready",
      spawnedRuntimeActors: 1
    });
    expect(arrived[0]!.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityId: ENTITY_ID,
        combatLevel: 7,
        combatTier: "uncommon",
        combatBalanceVersion: 2
      })
    ]));
    expect(harness.store.createCurrentGeneration).toHaveBeenCalledTimes(1);
    expect(harness.store.claimMobCombatProfilesForZones).toHaveBeenCalledOnce();
    expect(harness.store.claimMobCombatProfilesForZones).toHaveBeenCalledWith([{
      zoneId: ZONE_ID,
      level: 7,
      source: "zone_player_profile"
    }]);
    expect(harness.store.loadReadyEntitiesForZones).toHaveBeenCalledTimes(2);
    expect(harness.store.acquireRuntimeEntityLeases).toHaveBeenCalledOnce();
    expect(harness.combat.spawnMob).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: ENTITY_ID,
        combatProfile: {
          level: 7,
          tier: "uncommon",
          balanceVersion: 2
        }
      })
    );

    const strongerArrival = await harness.backend.activateZones({
      ...activation(0, challengeProfile(15)),
      preparedAuthoritiesByZone: {
        [ZONE_ID]: arrived[0]!.authority!
      }
    });
    expect(strongerArrival[0]!.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityId: ENTITY_ID,
        combatLevel: 7,
        combatTier: "uncommon",
        combatBalanceVersion: 2
      })
    ]));
    expect(harness.entity.combatLevel).toBe(7);
    expect(harness.store.loadReadyEntitiesForZones).toHaveBeenCalledTimes(3);
    expect(harness.backend.snapshot()).toMatchObject({
      generationsCreated: 1,
      activeRuntimeActors: 1
    });
    await harness.backend.close();
  });

  it("claims the durable mob life from the visible zone's unlocked challenge profile", async () => {
    const harness = createHarness();

    const first = await harness.backend.activateZones({
      ...activation(0),
      challengeProfilesByZone: {
        [ZONE_ID]: {
          currentGearLevel: 11,
          unlockedGearLevel: 16,
          tier: "epic",
          contributors: {
            melee: 11,
            chest: 11,
            secondary: 11
          },
          balanceVersion: 2
        }
      }
    });

    expect(harness.store.claimMobCombatProfilesForZones).toHaveBeenCalledWith([{
      zoneId: ZONE_ID,
      level: 16,
      source: "zone_player_profile",
      knownUnclaimed: true
    }]);
    expect(first[0]?.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityId: ENTITY_ID,
        combatLevel: 16,
        combatTier: "epic",
        combatBalanceVersion: 2
      })
    ]));
    expect(harness.combat.spawnMob).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: ENTITY_ID,
        combatProfile: {
          level: 16,
          tier: "epic",
          balanceVersion: 2
        }
      })
    );

    await harness.backend.activateZones({
      ...activation(0),
      challengeProfilesByZone: {
        [ZONE_ID]: {
          currentGearLevel: 25,
          unlockedGearLevel: 25,
          tier: "legendary",
          contributors: {
            melee: 25,
            chest: 25,
            secondary: 25
          },
          balanceVersion: 2
        }
      }
    });
    expect(harness.entity.combatLevel).toBe(16);
    expect(harness.entity.combatTier).toBe("epic");
    await harness.backend.close();
  });

  it("leaves background population without a combat profile", async () => {
    const harness = createHarness();

    await harness.backend.activateZones(activation(1));

    expect(harness.store.claimMobCombatProfilesForZones).not.toHaveBeenCalled();
    expect(harness.entity.combatLevel).toBeUndefined();
    expect(harness.entity.combatTier).toBeUndefined();
    expect(harness.entity.combatBalanceVersion).toBeUndefined();
    expect(harness.entity.combatProfileSource).toBeUndefined();
    await harness.backend.close();
  });

  it("claims an explicit zero-level player profile without treating it as missing", async () => {
    const harness = createHarness();

    const result = await harness.backend.activateZones(
      activation(0, challengeProfile(0))
    );

    expect(result[0]).toMatchObject({
      status: "ready",
      spawnedRuntimeActors: 1
    });
    expect(harness.store.claimMobCombatProfilesForZones).toHaveBeenCalledWith([{
      zoneId: ZONE_ID,
      level: 0,
      source: "zone_player_profile",
      knownUnclaimed: true
    }]);
    expect(harness.entity).toMatchObject({
      combatLevel: 0,
      combatTier: "common",
      combatBalanceVersion: 2,
      combatProfileSource: "zone_player_profile"
    });
    await harness.backend.close();
  });

  it("keeps simulation pending and warns when the authoritative profile is missing", async () => {
    const logger = {
      warn: vi.fn()
    } as unknown as NonNullable<
      ConstructorParameters<typeof PopulationZonesV2Backend>[4]
    >;
    const harness = createHarness({ logger });

    const result = await harness.backend.activateZones(activation(0, null));

    expect(result[0]).toMatchObject({
      status: "pending",
      completedStage: null,
      spawnedRuntimeActors: 0,
      reason: "backpressure-retry"
    });
    expect(harness.store.claimMobCombatProfilesForZones).not.toHaveBeenCalled();
    expect(harness.store.acquireRuntimeEntityLeases).not.toHaveBeenCalled();
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      trigger: "world-entry",
      priority: 0,
      targetStage: "SIMULATION_READY",
      activateRuntimeRequested: true,
      challengeProfilePresent: false
    }, "population simulation activation lacks an authoritative challenge profile");
    await harness.backend.close();
  });

  it("materializes construction priority 0 without activating runtime AI", async () => {
    const harness = createHarness();

    const result = await harness.backend.activateZones({
      ...activation(0),
      activateRuntime: false
    });

    expect(result[0]).toMatchObject({
      generationId: GENERATION_ID,
      status: "ready",
      spawnedRuntimeActors: 0
    });
    expect(harness.store.createCurrentGeneration).toHaveBeenCalledOnce();
    expect(harness.store.claimMobCombatProfilesForZones).not.toHaveBeenCalled();
    expect(harness.entity.combatLevel).toBeUndefined();
    expect(harness.store.acquireRuntimeEntityLeases).not.toHaveBeenCalled();
    expect(harness.combat.spawnMob).not.toHaveBeenCalled();
    expect(harness.backend.snapshot().activeRuntimeActors).toBe(0);
    await harness.backend.close();
  });

  it("writes combat runtime state through the active entity lease", async () => {
    const harness = createHarness();
    await harness.backend.activateZones(activation(0, challengeProfile(7)));
    const state: PopulationMobCombatRuntimeState = {
      schemaVersion: 1,
      revision: 1,
      archetype: "jellyfish",
      currentHealth: 600,
      maxHealth: 900,
      position: { lat: 39.7392, lon: -104.9903 },
      jellyfish: {
        stage: 2,
        retreatTriggered: true,
        secondRetreatTriggered: false,
        retreatsCompleted: 0,
        shadeEnabled: false,
        retreatPhase: "preparing",
        retreatStartPosition: null,
        retreatDestination: null,
        retreatStartedAtMs: null
      }
    };

    harness.emitRuntimeState(ENTITY_ID, state);
    await vi.waitFor(() => {
      expect(harness.store.updateReadyRuntimeEntityState).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: ENTITY_ID }),
        state
      );
    });
    await harness.backend.close();
  });

  it("serializes priority 0 after same-zone background creation", async () => {
    const harness = createHarness();
    let releaseBackground!: () => void;
    const backgroundBlocked = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    harness.planner.scheduleZonesAndWait.mockImplementation(async (input) => {
      if (input.priority === 1) await backgroundBlocked;
      return {
        disabled: false,
        readyZoneIds: input.zoneIds,
        pendingZoneIds: []
      };
    });

    const background = harness.backend.activateZones(activation(1));
    await vi.waitFor(() => {
      expect(harness.planner.scheduleZonesAndWait).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 1 })
      );
    });
    const foreground = harness.backend.activateZones(
      activation(0, challengeProfile(7))
    );
    let foregroundSettled = false;
    void foreground.then(() => {
      foregroundSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(foregroundSettled).toBe(false);

    releaseBackground();
    const [backgroundResult, foregroundResult] = await Promise.all([
      background,
      foreground
    ]);
    expect(backgroundResult[0]).toMatchObject({
      status: "ready",
      spawnedRuntimeActors: 0
    });
    expect(foregroundResult[0]).toMatchObject({
      status: "ready",
      spawnedRuntimeActors: 1
    });
    expect(harness.planner.scheduleZonesAndWait).toHaveBeenCalledOnce();
    expect(harness.store.createCurrentGeneration).toHaveBeenCalledOnce();
    expect(harness.store.claimMobCombatProfilesForZones).toHaveBeenCalledWith([{
      zoneId: ZONE_ID,
      level: 7,
      source: "zone_player_profile"
    }]);
    expect(harness.entity.combatLevel).toBe(7);
    await harness.backend.close();
  });

  it("creates one priority 0 generation and deduplicates duplicate activation", async () => {
    const harness = createHarness();

    const first = await harness.backend.activateZones(activation(0));
    const second = await harness.backend.activateZones(activation(0));

    expect(first[0]).toMatchObject({
      generationId: GENERATION_ID,
      status: "ready",
      spawnedRuntimeActors: 1
    });
    expect(second[0]).toMatchObject({
      generationId: GENERATION_ID,
      status: "ready",
      spawnedRuntimeActors: 0
    });
    expect(harness.store.createCurrentGeneration).toHaveBeenCalledTimes(1);
    expect(harness.store.acquireRuntimeEntityLeases).toHaveBeenCalledTimes(1);
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(1);
    expect(harness.combat.spawnMob).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: ENTITY_ID,
        worldAi: true,
        lifeGeneration: 0,
        populationAuthority: {
          ownerToken: "00000000-0000-4000-8000-000000000030",
          fencingGeneration: 1,
          cutoverRevision: 1
        }
      })
    );
    expect(harness.backend.snapshot()).toMatchObject({
      activeRuntimeActors: 1,
      deduplicatedRuntimeActivations: 1,
      generationsCreated: 1,
      preventedDuplicateGenerationAttempts: 0,
      invariantGenerationCleanups: 0
    });
    await harness.backend.close();
  });

  it("keeps flag-triggered activation independent from a Resin Crawler group", async () => {
    const harness = createHarness();
    const current = await harness.store.loadReadyEntitiesForZones([ZONE_ID]);
    const sapCrawler = {
      ...current[0]!,
      entityKind: "sap_crawler" as const,
      archetype: "sap_crawler",
      encounterId: "00000000-0000-4000-8000-000000000040",
      packId: "00000000-0000-4000-8000-000000000041",
      packMemberIndex: 0,
      combatLevel: 0,
      combatTier: "common" as const,
      combatBalanceVersion: 2,
      combatProfileSource: "zone_player_profile" as const
    };
    harness.store.loadReadyEntitiesForZones.mockResolvedValue([sapCrawler]);

    await harness.backend.activateZones({
      ...activation(0),
      trigger: "flag-travel"
    });
    await harness.backend.activateZones({
      ...activation(0),
      trigger: "flag-travel",
      activateRuntime: false
    });

    expect(harness.combat.spawnMob).toHaveBeenCalledOnce();
    expect(harness.combat.spawnMob).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: sapCrawler.entityId,
        archetype: "sap_crawler",
        packId: sapCrawler.packId,
        originFlagId: null
      })
    );
    expect(harness.combat.despawnMob).not.toHaveBeenCalled();
    expect(harness.backend.snapshot().activeRuntimeActors).toBe(1);
    await harness.backend.close();
  });

  it("serves a compatible legacy generation without activation maintenance", async () => {
    const harness = createHarness({
      initialGeneration: {
        ...generationRecord(),
        densityRevision: "legacy-unverified",
        planContentHash: "legacy-unverified",
        candidateLayoutVersion: "legacy-unverified",
        materializationRevision: "legacy-unverified"
      }
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        harness.backend.activateZones(activation(0))
      )
    );

    expect(results.every((result) =>
      result[0]?.status === "ready"
      && result[0]?.materializationStatus ===
        "materialization-stale-but-servable"
      && result[0]?.entities.some((entity) => entity.entityId === ENTITY_ID)
    )).toBe(true);
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    expect(harness.combat.spawnMob).toHaveBeenCalledOnce();
    expect(harness.backend.snapshot().staleMaterializationServed).toBe(1);
    expect(harness.backend.snapshot().materializationReconciliationActive)
      .toBe(false);
    await harness.backend.close();
  });

  it("serves retained v9 entities without replacement or mutation", async () => {
    const harness = createHarness({
      initialGeneration: {
        ...generationRecord(),
        materializationRevision:
          "population-generation-materialization-v9-coastal-body-density"
      }
    });
    const before = harness.generation();

    const result = await harness.backend.activateZones(activation(1));

    expect(result[0]).toMatchObject({
      status: "ready",
      materializationStatus: "materialization-stale-but-servable",
      generationId: GENERATION_ID,
      entities: expect.arrayContaining([
        expect.objectContaining({ entityId: ENTITY_ID })
      ])
    });
    expect(harness.generation()).toEqual(before);
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    expect(harness.store.claimMobCombatProfilesForZones).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("serves an active zero-reference V1 generation read-only", async () => {
    const harness = createHarness({
      initialGeneration: {
        ...generationRecord(),
        plannedNonStoneCount: 9,
        currentReferenceCount: 0,
        materializationRevision:
          "population-generation-materialization-v1"
      }
    });

    const result = await harness.backend.activateZones({
      ...activation(0),
      trigger: "flag-travel"
    });

    expect(result[0]).toMatchObject({
      status: "ready",
      materializationStatus: "materialization-stale-but-servable",
      entities: expect.arrayContaining([
        expect.objectContaining({ entityId: ENTITY_ID }),
        expect.objectContaining({
          entityId: STONE_ID,
          generationId: null
        })
      ])
    });
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    expect(harness.backend.snapshot().currentGenerations).toEqual([
      expect.objectContaining({
        generationId: GENERATION_ID,
        plannedNonStoneCount: 9,
        materializationRevision:
          "population-generation-materialization-v1",
        materializationStatus: "materialization-stale-but-servable"
      })
    ]);
    await harness.backend.close();
  });

  it("treats a legitimate zero-density V1 generation as terminal ready", async () => {
    const harness = createHarness({
      initialGeneration: {
        ...generationRecord(),
        plannedNonStoneCount: 0,
        materializationRevision:
          "population-generation-materialization-v1"
      }
    });
    harness.store.loadReadyEntitiesForZones.mockResolvedValue([]);

    const result = await harness.backend.activateZones(activation(0));

    expect(result[0]).toMatchObject({
      status: "ready",
      materializationStatus: "materialization-stale-but-servable",
      entities: []
    });
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("serves mixed V1, V2, and V3 generations together", async () => {
    const harness = createHarness({
      initialGeneration: generationRecord()
    });
    const revisions = new Map<string, string>([
      [ZONE_ID, "population-generation-materialization-v1"],
      [OTHER_ZONE_ID, POPULATION_GENERATION_MATERIALIZATION_REVISION],
      [THIRD_ZONE_ID, "population-generation-materialization-v3"]
    ]);
    const generationIds = new Map<string, string>([
      [ZONE_ID, GENERATION_ID],
      [OTHER_ZONE_ID, OTHER_GENERATION_ID],
      [THIRD_ZONE_ID, NEXT_GENERATION_ID]
    ]);
    harness.store.loadCurrentGenerations.mockImplementation(async (
      zoneIds: readonly string[]
    ) => zoneIds.map((zoneId) => ({
      ...generationRecord(generationIds.get(zoneId)!, 1),
      zoneId,
      materializationRevision: revisions.get(zoneId)!
    })));
    harness.store.loadReadyEntitiesForZones.mockImplementation(async (
      zoneIds: readonly string[]
    ) => zoneIds.map((zoneId) => ({
      ...harness.entity,
      zoneId,
      generationId: generationIds.get(zoneId)!,
      entityId: generationIds.get(zoneId)!
    })));

    const result = await harness.backend.activateZones({
      ...activation(0),
      zoneIds: [ZONE_ID, OTHER_ZONE_ID, THIRD_ZONE_ID],
      priorityByZone: {
        [ZONE_ID]: 0,
        [OTHER_ZONE_ID]: 0,
        [THIRD_ZONE_ID]: 0
      },
      activateRuntime: false
    });

    expect(result.map((entry) => [
      entry.zoneId,
      entry.status,
      entry.materializationStatus
    ])).toEqual([
      [OTHER_ZONE_ID, "ready", "materialization-current"],
      [THIRD_ZONE_ID, "ready", "materialization-stale-but-servable"],
      [ZONE_ID, "ready", "materialization-stale-but-servable"]
    ].sort(([left], [right]) => String(left).localeCompare(String(right))));
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("reports unknown materialization separately from lifecycle work", async () => {
    const harness = createHarness({
      initialGeneration: {
        ...generationRecord(),
        materializationRevision: "future-materialization-v99"
      }
    });

    const result = await harness.backend.activateZones(activation(0));

    expect(result[0]).toMatchObject({
      generationId: GENERATION_ID,
      status: "pending",
      materializationStatus: "guarded-materialization",
      entities: []
    });
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    expect(harness.store.loadReadyEntitiesForZones).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("fences an unsupported V1 mob without rejecting a ready neighbor", async () => {
    const harness = createHarness({
      initialGeneration: generationRecord()
    });
    harness.store.loadCurrentGenerations.mockImplementation(async (
      zoneIds: readonly string[]
    ) => zoneIds.map((zoneId) => ({
      ...generationRecord(
        zoneId === ZONE_ID ? GENERATION_ID : OTHER_GENERATION_ID,
        1
      ),
      zoneId,
      materializationRevision: zoneId === ZONE_ID
        ? "population-generation-materialization-v1"
        : POPULATION_GENERATION_MATERIALIZATION_REVISION
    })));
    harness.store.loadReadyEntitiesForZones.mockImplementation(async (
      zoneIds: readonly string[]
    ) => zoneIds.map((zoneId) => ({
      ...harness.entity,
      zoneId,
      generationId: zoneId === ZONE_ID
        ? GENERATION_ID
        : OTHER_GENERATION_ID,
      entityId: zoneId === ZONE_ID ? ENTITY_ID : OTHER_ENTITY_ID,
      archetype: zoneId === ZONE_ID ? "retired_wolf" : "wolf"
    })));

    const result = await harness.backend.activateZones({
      ...activation(0),
      zoneIds: [ZONE_ID, OTHER_ZONE_ID],
      priorityByZone: { [ZONE_ID]: 0, [OTHER_ZONE_ID]: 0 },
      activateRuntime: false
    });
    const byZone = new Map(result.map((entry) => [entry.zoneId, entry]));

    expect(byZone.get(ZONE_ID)).toMatchObject({
      status: "ready",
      materializationStatus: "materialization-stale-but-servable",
      entities: []
    });
    expect(byZone.get(OTHER_ZONE_ID)).toMatchObject({
      status: "ready",
      entities: [expect.objectContaining({ entityId: OTHER_ENTITY_ID })]
    });
    expect(harness.backend.snapshot()).toMatchObject({
      invariantViolations: 1,
      invariantEntitiesSuppressed: 1
    });
    await harness.backend.close();
  });

  it("isolates an unsupported per-kind revision from a ready neighbor", async () => {
    const harness = createHarness({
      initialGeneration: generationRecord()
    });
    harness.store.loadCurrentGenerations.mockImplementation(async (
      zoneIds: readonly string[]
    ) => zoneIds.map((zoneId) => ({
      ...generationRecord(
        zoneId === ZONE_ID ? GENERATION_ID : OTHER_GENERATION_ID,
        1
      ),
      zoneId
    })));
    harness.store.loadReadyEntitiesForZones.mockImplementation(async (
      zoneIds: readonly string[]
    ) => zoneIds.map((zoneId) => ({
      ...harness.entity,
      zoneId,
      generationId: zoneId === ZONE_ID
        ? GENERATION_ID
        : OTHER_GENERATION_ID,
      entityId: zoneId === ZONE_ID ? ENTITY_ID : OTHER_ENTITY_ID,
      environmentSnapshot: zoneId === ZONE_ID
        ? { placementRevision: "retired-wolf-placement-v0" }
        : {}
    })));

    const result = await harness.backend.activateZones({
      ...activation(0),
      zoneIds: [ZONE_ID, OTHER_ZONE_ID],
      priorityByZone: { [ZONE_ID]: 0, [OTHER_ZONE_ID]: 0 },
      activateRuntime: false
    });
    const byZone = new Map(result.map((entry) => [entry.zoneId, entry]));

    expect(byZone.get(ZONE_ID)).toMatchObject({
      status: "ready",
      entities: []
    });
    expect(byZone.get(OTHER_ZONE_ID)).toMatchObject({
      status: "ready",
      entities: [expect.objectContaining({ entityId: OTHER_ENTITY_ID })]
    });
    expect(harness.backend.snapshot()).toMatchObject({
      invariantViolations: 1,
      invariantEntitiesSuppressed: 1
    });
    await harness.backend.close();
  });

  it("keeps optional materialization maintenance outside player activation", async () => {
    const harness = createHarness({
      initialGeneration: {
        ...generationRecord(),
        materializationRevision: "population-generation-materialization-v3"
      }
    });

    const result = await harness.backend.activateZones(activation(0));

    expect(result[0]).toMatchObject({
      status: "ready",
      entities: expect.arrayContaining([
        expect.objectContaining({ entityId: ENTITY_ID })
      ])
    });
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("does not head-of-line block one zone behind another zone activation", async () => {
    const harness = createHarness({
      initialGeneration: generationRecord()
    });
    let releaseSlowLoad!: () => void;
    const slowLoad = new Promise<void>((resolve) => {
      releaseSlowLoad = resolve;
    });
    let slowLoadStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      slowLoadStarted = resolve;
    });
    harness.store.loadCurrentGenerations.mockImplementation(async (
      zoneIds: readonly string[]
    ) => {
      const zoneId = zoneIds[0]!;
      if (zoneId === ZONE_ID) {
        slowLoadStarted();
        await slowLoad;
      }
      return [{
        ...generationRecord(
          zoneId === ZONE_ID ? GENERATION_ID : OTHER_GENERATION_ID
        ),
        zoneId
      }];
    });
    harness.store.loadReadyEntitiesForZones.mockImplementation(
      async (zoneIds: readonly string[]) => zoneIds.map((zoneId) => ({
        ...harness.entity,
        zoneId,
        generationId: zoneId === ZONE_ID
          ? GENERATION_ID
          : OTHER_GENERATION_ID,
        entityId: zoneId === ZONE_ID ? ENTITY_ID : OTHER_ENTITY_ID,
        combatLevel: 0,
        combatTier: "common" as const,
        combatBalanceVersion: 2,
        combatProfileSource: "zone_player_profile" as const
      }))
    );

    const slow = harness.backend.activateZones(activation(0));
    await slowStarted;
    let independentFinished = false;
    const independent = harness.backend.activateZones({
      ...activation(0),
      zoneIds: [OTHER_ZONE_ID],
      priorityByZone: { [OTHER_ZONE_ID]: 0 },
      challengeProfilesByZone: {
        [OTHER_ZONE_ID]: challengeProfile(0)
      }
    }).then((result) => {
      independentFinished = result[0]?.status === "ready";
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedBeforeSlowRelease = independentFinished;

    releaseSlowLoad();
    await Promise.all([slow, independent]);
    await harness.backend.close();
    expect(finishedBeforeSlowRelease).toBe(true);
  });

  it("uses the zone actor index for a small-zone removal", async () => {
    const harness = createHarness({
      initialGeneration: generationRecord()
    });
    let includePrimary = true;
    harness.store.loadCurrentGenerations.mockImplementation(async (
      zoneIds: readonly string[]
    ) => zoneIds.map((zoneId) => ({
      ...generationRecord(
        zoneId === ZONE_ID ? GENERATION_ID : OTHER_GENERATION_ID
      ),
      zoneId
    })));
    harness.store.loadReadyEntitiesForZones.mockImplementation(async (
      zoneIds: readonly string[]
    ) => zoneIds.flatMap((zoneId) => {
      if (zoneId === ZONE_ID && !includePrimary) return [];
      return [{
        ...harness.entity,
        zoneId,
        generationId: zoneId === ZONE_ID
          ? GENERATION_ID
          : OTHER_GENERATION_ID,
        entityId: zoneId === ZONE_ID ? ENTITY_ID : OTHER_ENTITY_ID,
        combatLevel: 0,
        combatTier: "common" as const,
        combatBalanceVersion: 2,
        combatProfileSource: "zone_player_profile" as const
      }];
    }));

    await harness.backend.activateZones({
      ...activation(0),
      zoneIds: [ZONE_ID, OTHER_ZONE_ID],
      priorityByZone: { [ZONE_ID]: 0, [OTHER_ZONE_ID]: 0 },
      challengeProfilesByZone: {
        [ZONE_ID]: challengeProfile(0),
        [OTHER_ZONE_ID]: challengeProfile(0)
      }
    });
    expect(harness.backend.snapshot()).toMatchObject({
      activeRuntimeActors: 2,
      activeRuntimeActorsByZone: {
        [ZONE_ID]: 1,
        [OTHER_ZONE_ID]: 1
      },
      activeRuntimeActorIndexEntries: 2,
      activeRuntimeActorIndexZones: 2,
      activeRuntimeActorIndexConsistent: true
    });

    includePrimary = false;
    const globalRegistry = (
      harness.backend as unknown as {
        activeRuntimeEntities: Map<string, unknown>;
      }
    ).activeRuntimeEntities;
    Object.defineProperty(globalRegistry, "values", {
      configurable: true,
      value: () => {
        throw new Error("small-zone activation scanned the global registry");
      }
    });
    try {
      await harness.backend.activateZones(activation(0));
    } finally {
      Reflect.deleteProperty(globalRegistry, "values");
    }

    expect(harness.combat.despawnMob).toHaveBeenCalledWith(ENTITY_ID);
    expect(harness.combat.despawnMob).not.toHaveBeenCalledWith(
      OTHER_ENTITY_ID
    );
    expect(harness.backend.snapshot()).toMatchObject({
      activeRuntimeActors: 1,
      activeRuntimeActorsByZone: { [OTHER_ZONE_ID]: 1 },
      activeRuntimeActorIndexEntries: 1,
      activeRuntimeActorIndexZones: 1,
      activeRuntimeActorIndexConsistent: true
    });
    await harness.backend.close();
  });

  it("serves compatible legacy durable entities without reconciliation", async () => {
    const harness = createHarness({
      initialGeneration: {
        ...generationRecord(),
        densityRevision: "legacy-unverified",
        planContentHash: "legacy-unverified",
        candidateLayoutVersion: "legacy-unverified",
        materializationRevision: "legacy-unverified"
      }
    });
    const result = await harness.backend.activateZones(activation(0));

    expect(result[0]).toMatchObject({
      status: "ready",
      materializationStatus: "materialization-stale-but-servable",
      entities: expect.arrayContaining([
        expect.objectContaining({ entityId: ENTITY_ID })
      ])
    });
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("suppresses excess and obsolete non-stone entities at the planned cap", async () => {
    const harness = createHarness();
    harness.store.loadReadyEntitiesForZones.mockImplementation(async () => [
      harness.entity,
      {
        ...harness.entity,
        slotId: "excess-generation-slot",
        entityId: EXTRA_ENTITY_ID
      },
      {
        ...harness.entity,
        generationId: NEXT_GENERATION_ID,
        slotId: "obsolete-generation-slot",
        entityId: OBSOLETE_ENTITY_ID
      },
      harness.stone
    ]);

    const result = await harness.backend.activateZones(activation(0));

    expect(result[0]?.entities.map((entity) => entity.entityId)).toEqual([
      ENTITY_ID,
      STONE_ID
    ]);
    expect(harness.store.acquireRuntimeEntityLeases).toHaveBeenCalledWith([
      expect.objectContaining({ entityId: ENTITY_ID })
    ], expect.any(Number));
    expect(harness.combat.spawnMob).toHaveBeenCalledTimes(1);
    expect(harness.backend.snapshot()).toMatchObject({
      activeRuntimeActors: 1,
      invariantViolations: 2,
      invariantEntitiesSuppressed: 2,
      currentGenerations: [
        expect.objectContaining({
          plannedNonStoneCount: 1,
          activeNonStoneCount: 1
        })
      ]
    });
    await harness.backend.close();
  });

  it("rolls an expired referenced generation for foreground simulation demand", async () => {
    const harness = createHarness();
    await harness.backend.activateZones(activation(0));
    const fixedExpiry = new Date(Date.now() - 1);
    harness.setGeneration({
      ...harness.generation()!,
      expiresAt: fixedExpiry,
      status: "active"
    });
    const refreshed = vi.fn();
    harness.backend.onGenerationRefreshReady(refreshed);

    const result = await harness.backend.activateZones(activation(0));

    expect(harness.store.markGenerationExpired).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      generationId: GENERATION_ID,
      currentReferences: 1,
      now: expect.any(Date)
    });
    expect(harness.store.cleanupExpiredGeneration).not.toHaveBeenCalled();
    expect(harness.store.createCurrentGeneration).toHaveBeenLastCalledWith({
      zoneId: ZONE_ID,
      planId: PLAN_ID,
      now: expect.any(Date),
      currentReferences: 1,
      replaceExpiredReferencedGeneration: true
    });
    expect(result[0]).toMatchObject({
      generationId: NEXT_GENERATION_ID,
      status: "ready",
      removedEntityIds: [ENTITY_ID]
    });
    expect(harness.generation()).toMatchObject({
      generationId: NEXT_GENERATION_ID,
      status: "active",
      currentReferenceCount: 1
    });
    expect(harness.generation()!.expiresAt.getTime())
      .toBeGreaterThan(fixedExpiry.getTime());
    expect(refreshed).toHaveBeenCalledWith(ZONE_ID);
    expect(harness.combat.despawnMob).toHaveBeenCalledWith(ENTITY_ID);
    await harness.backend.close();
  });

  it("leaves occupied expiry pending for background durable work", async () => {
    const harness = createHarness();
    await harness.backend.activateZones(activation(0));
    const fixedExpiry = new Date(Date.now() - 1);
    harness.setGeneration({
      ...harness.generation()!,
      expiresAt: fixedExpiry,
      status: "active"
    });

    const result = await harness.backend.activateZones(activation(1));

    expect(harness.store.createCurrentGeneration).toHaveBeenCalledOnce();
    expect(result[0]).toMatchObject({
      generationId: GENERATION_ID,
      status: "pending"
    });
    expect(harness.generation()?.expiresAt).toEqual(fixedExpiry);
    await harness.backend.close();
  });

  it("sweeps due generations independently of visits and preserves references", async () => {
    const harness = createHarness({
      initialGeneration: expiredGeneration(),
      cleanupResult: true
    });
    harness.backend.updateZoneReferences({
      currentReferencesByZone: { [ZONE_ID]: 2 }
    });

    await harness.backend.sweepExpiredGenerations();

    expect(harness.store.loadDueCurrentGenerations).toHaveBeenCalledWith({
      now: expect.any(Date),
      limit: 128
    });
    expect(harness.store.markGenerationExpired).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      generationId: GENERATION_ID,
      currentReferences: 2,
      now: expect.any(Date)
    });
    expect(harness.store.cleanupExpiredGeneration).not.toHaveBeenCalled();
    expect(harness.generation()).toMatchObject({
      status: "refresh-pending",
      currentReferenceCount: 2
    });
    await harness.backend.close();
  });

  it("cleans dormant due generations after grace and notifies refresh waiters", async () => {
    const harness = createHarness({
      initialGeneration: expiredGeneration(),
      cleanupResult: true
    });
    const refreshed = vi.fn();
    harness.backend.onGenerationRefreshReady(refreshed);

    await harness.backend.sweepExpiredGenerations();

    expect(harness.store.cleanupExpiredGeneration).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      generationId: GENERATION_ID,
      unreferenced: true,
      now: expect.any(Date)
    });
    expect(refreshed).toHaveBeenCalledWith(ZONE_ID);
    expect(harness.generation()).toBeNull();
    await harness.backend.close();
  });

  it("does not sweep a zero-reference runtime cache before sleep releases it", async () => {
    const harness = createHarness({
      initialGeneration: expiredGeneration(),
      cleanupResult: true
    });
    harness.backend.updateZoneReferences({
      currentReferencesByZone: { [ZONE_ID]: 0 },
      unreferencedAtByZone: { [ZONE_ID]: Date.now() - 60_000 }
    });

    await harness.backend.sweepExpiredGenerations();
    expect(harness.store.cleanupExpiredGeneration).not.toHaveBeenCalled();

    await harness.backend.sleepZones({
      zoneIds: [ZONE_ID],
      unreferencedAtByZone: { [ZONE_ID]: Date.now() - 60_000 }
    });
    expect(harness.store.cleanupExpiredGeneration).toHaveBeenCalledOnce();
    expect(harness.generation()).toBeNull();
    await harness.backend.close();
  });

  it("stops the periodic generation sweep when the backend closes", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ generationSweepMs: 25 });
      await vi.advanceTimersByTimeAsync(25);
      expect(harness.store.loadDueCurrentGenerations).toHaveBeenCalledOnce();

      await harness.backend.close();
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.store.loadDueCurrentGenerations).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases actors before expiring and cleaning a sleeping generation", async () => {
    const harness = createHarness({ cleanupResult: true });
    await harness.backend.activateZones(activation(0));
    harness.setGeneration({
      ...harness.generation()!,
      expiresAt: new Date(Date.now() - 60_000)
    });

    const slept = await harness.backend.sleepZones({ zoneIds: [ZONE_ID] });

    expect(slept).toEqual({
      removedEntityIds: [ENTITY_ID],
      sleptRuntimeActors: 1
    });
    expect(harness.store.releaseRuntimeEntityLeases).toHaveBeenCalledWith([
      expect.objectContaining({ entityId: ENTITY_ID })
    ]);
    expect(
      harness.store.releaseRuntimeEntityLeases.mock.invocationCallOrder[0]
    ).toBeLessThan(
      harness.store.markGenerationExpired.mock.invocationCallOrder[0]!
    );
    expect(harness.store.markGenerationExpired).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      generationId: GENERATION_ID,
      currentReferences: 0,
      now: expect.any(Date)
    });
    expect(harness.store.cleanupExpiredGeneration).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      generationId: GENERATION_ID,
      unreferenced: true,
      now: expect.any(Date)
    });
    expect(harness.backend.snapshot()).toMatchObject({
      activeRuntimeActors: 0,
      invariantGenerationCleanups: 1
    });
    await harness.backend.close();
  });

  it("retires sleeping combat actors before a durable lease release can fail", async () => {
    const harness = createHarness();
    await harness.backend.activateZones(activation(0));
    harness.store.releaseRuntimeEntityLeases.mockRejectedValueOnce(
      new Error("lease store unavailable")
    );

    await expect(harness.backend.sleepZones({ zoneIds: [ZONE_ID] }))
      .rejects.toThrow("lease store unavailable");

    expect(harness.combat.despawnMob).toHaveBeenCalledWith(ENTITY_ID);
    expect(harness.combat.despawnMob.mock.invocationCallOrder[0])
      .toBeLessThan(
        harness.store.releaseRuntimeEntityLeases.mock.invocationCallOrder[0]!
      );
    expect(harness.backend.snapshot().activeRuntimeActors).toBe(0);
    await harness.backend.close();
  });

  it("retires closing combat actors before a durable lease release can fail", async () => {
    const harness = createHarness();
    await harness.backend.activateZones(activation(0));
    harness.store.releaseRuntimeEntityLeases.mockRejectedValueOnce(
      new Error("lease store unavailable")
    );

    await expect(harness.backend.close()).rejects.toThrow("lease store unavailable");

    expect(harness.combat.despawnMob).toHaveBeenCalledWith(ENTITY_ID);
    expect(harness.combat.despawnMob.mock.invocationCallOrder[0])
      .toBeLessThan(
        harness.store.releaseRuntimeEntityLeases.mock.invocationCallOrder[0]!
      );
    expect(harness.backend.snapshot().activeRuntimeActors).toBe(0);
  });

  it("retires obsolete combat actors before a cutover lease release can fail", async () => {
    const harness = createHarness();
    await harness.backend.activateZones(activation(0));
    harness.entity = { ...harness.entity, stateRevision: 1 };
    harness.store.releaseRuntimeEntityLeases.mockRejectedValueOnce(
      new Error("lease store unavailable")
    );

    await expect(harness.backend.activateZones(activation(0)))
      .rejects.toThrow("lease store unavailable");

    expect(harness.combat.despawnMob).toHaveBeenCalledWith(ENTITY_ID);
    expect(harness.combat.despawnMob.mock.invocationCallOrder[0])
      .toBeLessThan(
        harness.store.releaseRuntimeEntityLeases.mock.invocationCallOrder[0]!
      );
    expect(harness.backend.snapshot().activeRuntimeActors).toBe(0);
    await harness.backend.close();
  });

  it("preserves a generation reacquired while its final sleep is releasing actors", async () => {
    const harness = createHarness({ cleanupResult: true });
    await harness.backend.activateZones(activation(0));
    harness.setGeneration({
      ...harness.generation()!,
      expiresAt: new Date(Date.now() - 60_000)
    });
    let releaseLease!: (released: number) => void;
    harness.store.releaseRuntimeEntityLeases.mockImplementationOnce(() =>
      new Promise<number>((resolve) => {
        releaseLease = resolve;
      })
    );

    const sleeping = harness.backend.sleepZones({ zoneIds: [ZONE_ID] });
    await vi.waitFor(() => {
      expect(harness.store.releaseRuntimeEntityLeases).toHaveBeenCalledOnce();
    });
    harness.backend.updateZoneReferences({
      currentReferencesByZone: { [ZONE_ID]: 1 }
    });
    releaseLease(1);
    await sleeping;

    expect(harness.store.markGenerationExpired).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      generationId: GENERATION_ID,
      currentReferences: 1,
      now: expect.any(Date)
    });
    expect(harness.store.cleanupExpiredGeneration).not.toHaveBeenCalled();
    expect(harness.generation()).toMatchObject({
      generationId: GENERATION_ID,
      status: "refresh-pending",
      currentReferenceCount: 1
    });
    await harness.backend.close();
  });

  it("keeps an unreferenced expired generation pending during safety grace", async () => {
    const harness = createHarness({
      initialGeneration: {
        ...expiredGeneration(),
        materializationRevision:
          "population-generation-materialization-v1"
      },
      cleanupResult: false
    });

    const result = await harness.backend.activateZones(activation(0));

    expect(result[0]).toMatchObject({
      generationId: GENERATION_ID,
      status: "pending",
      materializationStatus: "generation-lifecycle-pending",
      entities: [],
      spawnedRuntimeActors: 0
    });
    expect(harness.store.cleanupExpiredGeneration).toHaveBeenCalledTimes(1);
    expect(harness.store.createCurrentGeneration).not.toHaveBeenCalled();
    expect(harness.store.loadReadyEntitiesForZones).not.toHaveBeenCalled();
    await harness.backend.close();
  });

  it("replaces an expired unreferenced generation only after cleanup succeeds", async () => {
    const harness = createHarness({
      initialGeneration: expiredGeneration(),
      cleanupResult: true
    });

    const result = await harness.backend.activateZones(activation(0));

    expect(harness.store.cleanupExpiredGeneration).toHaveBeenCalledTimes(1);
    expect(harness.store.createCurrentGeneration).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({
      generationId: NEXT_GENERATION_ID,
      status: "ready"
    });
    expect(harness.backend.snapshot()).toMatchObject({
      generationsCreated: 1,
      invariantGenerationCleanups: 1
    });
    await harness.backend.close();
  });

  it("releases an acquired lease if runtime spawn fails", async () => {
    const harness = createHarness();
    harness.combat.spawnMob.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    await expect(harness.backend.activateZones(activation(0)))
      .rejects.toThrow("spawn failed");

    expect(harness.store.releaseRuntimeEntityLeases).toHaveBeenCalledWith([
      expect.objectContaining({ entityId: ENTITY_ID })
    ]);
    expect(harness.backend.snapshot()).toMatchObject({
      activeRuntimeActors: 0,
      lastActivationError: "spawn failed"
    });
    await harness.backend.close();
  });

  it("reconciles an untracked Population actor only after acquiring its fenced lease", async () => {
    const harness = createHarness();
    harness.combat.despawnPopulationManagedMob.mockReturnValueOnce(true);

    await harness.backend.activateZones(activation(0));

    expect(harness.combat.despawnPopulationManagedMob)
      .toHaveBeenCalledWith(ENTITY_ID);
    expect(harness.store.acquireRuntimeEntityLeases.mock.invocationCallOrder[0])
      .toBeLessThan(
        harness.combat.despawnPopulationManagedMob.mock.invocationCallOrder[0]!
      );
    expect(harness.combat.despawnPopulationManagedMob.mock.invocationCallOrder[0])
      .toBeLessThan(harness.combat.spawnMob.mock.invocationCallOrder[0]!);
    expect(harness.backend.snapshot()).toMatchObject({
      activeRuntimeActors: 1,
      orphanedRuntimeActorReconciliations: 1
    });
    await harness.backend.close();
  });

  it("rebinds a revision-only lease fence without churning the combat actor", async () => {
    const harness = createHarness();
    await harness.backend.activateZones(activation(0));
    harness.entity = {
      ...harness.entity,
      cutoverRevision: 2
    };

    await harness.backend.activateZones(activation(0));

    expect(harness.store.rebindRuntimeEntityLease).toHaveBeenCalledOnce();
    expect(harness.combat.rebindPopulationAuthority).toHaveBeenCalledOnce();
    expect(harness.combat.spawnMob).toHaveBeenCalledOnce();
    expect(harness.combat.despawnMob).not.toHaveBeenCalled();
    expect(harness.backend.snapshot()).toMatchObject({
      activeRuntimeActors: 1,
      actorInPlaceRebinds: 1,
      mobDespawnsByReason: {}
    });
    await harness.backend.close();
  });

  it("renews one unaffected actor for one hundred heartbeats without despawn", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        runtimeLeaseMs: 30_000,
        runtimeHeartbeatMs: 10_000,
        generationSweepMs: 2_000_000
      });
      await harness.backend.activateZones(activation(0));

      await vi.advanceTimersByTimeAsync(1_000_000);

      expect(harness.store.renewRuntimeEntityLeases).toHaveBeenCalledTimes(100);
      expect(harness.combat.spawnMob).toHaveBeenCalledOnce();
      expect(harness.combat.despawnMob).not.toHaveBeenCalled();
      expect(harness.backend.snapshot()).toMatchObject({
        activeRuntimeActors: 1,
        mobDespawnsByReason: {}
      });
      await harness.backend.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

function activation(
  priority: 0 | 1 | 2,
  profile: ReturnType<typeof challengeProfile> | null = challengeProfile(0)
) {
  return {
    zoneIds: [ZONE_ID],
    trigger: "world-entry" as const,
    relocationRevision: 1,
    resourceVisionRevision: 1,
    priorityByZone: { [ZONE_ID]: priority },
    ...(priority === 0 && profile !== null
      ? { challengeProfilesByZone: { [ZONE_ID]: profile } }
      : {})
  };
}

function createHarness(options: Readonly<{
  initialGeneration?: PopulationZoneV2GenerationRecord | null;
  cleanupResult?: boolean;
  generationSweepMs?: number;
  runtimeLeaseMs?: number;
  runtimeHeartbeatMs?: number;
  logger?: ConstructorParameters<typeof PopulationZonesV2Backend>[4];
}> = {}) {
  let runtimeStateSink: ((
    entityId: string,
    state: PopulationMobCombatRuntimeState
  ) => void) | null = null;
  let currentGeneration = options.initialGeneration === undefined
    ? null
    : options.initialGeneration;
  let generationNumber = currentGeneration?.generationNumber ?? 0;
  let entity: PopulationZoneV2ReadyEntity = {
    planId: PLAN_ID,
    zoneId: ZONE_ID,
    generationId: GENERATION_ID,
    cutoverRevision: 1,
    slotId: "generation-slot",
    entityId: ENTITY_ID,
    entityKind: "wolf" as const,
    archetype: "wolf",
    encounterId: null,
    packId: null,
    packMemberIndex: null,
    lat: 39.7392,
    lon: -104.9903,
    anchorLat: 39.739,
    anchorLon: -104.99,
    environmentSnapshot: {},
    suppressionClass: "hostile-pack" as const,
    stateRevision: 0
  };
  const stone = {
    ...entity,
    generationId: null,
    slotId: "permanent-stone-slot",
    entityId: STONE_ID,
    entityKind: "stone" as const,
    archetype: "stone_mine",
    suppressionClass: "none" as const
  };
  const planner = {
    prefetchEnvironmentForZones: vi.fn(async () => ({
      disposition: "prefetched" as const,
      requestedZoneIds: [ZONE_ID, OTHER_ZONE_ID],
      readyPlanZoneIds: [],
      terminalFailureZoneIds: [],
      unresolvedPlanZoneIds: [ZONE_ID, OTHER_ZONE_ID],
      environment: null
    })),
    scheduleZones: vi.fn(async (
      input: Parameters<PopulationZonesV2Planner["scheduleZones"]>[0]
    ) => ({
      disabled: false,
      readyZoneIds: input.zoneIds,
      pendingZoneIds: []
    })),
    scheduleZonesAndWait: vi.fn(async (
      input: Parameters<PopulationZonesV2Planner["scheduleZonesAndWait"]>[0]
    ) => ({
      disabled: false,
      readyZoneIds: input.zoneIds,
      pendingZoneIds: []
    }))
  } satisfies Pick<
    PopulationZonesV2Planner,
    | "prefetchEnvironmentForZones"
    | "scheduleZones"
    | "scheduleZonesAndWait"
  >;
  const store = {
    ensurePlanForZone: vi.fn(async (request: PopulationZoneV2PlanRequest) => ({
      ...request,
      planId: PLAN_ID,
      status: "ready" as const,
      claimGeneration: 1,
      attemptCount: 1,
      contentHash: "ready"
    })),
    createCurrentGeneration: vi.fn(async (input: {
      now?: Date;
      currentReferences?: number;
      replaceExpiredReferencedGeneration?: boolean;
    }) => {
      if (currentGeneration !== null) {
        if (
          input.replaceExpiredReferencedGeneration === true
          && currentGeneration.expiresAt.getTime()
            <= (input.now ?? new Date()).getTime()
        ) {
          generationNumber += 1;
          currentGeneration = {
            ...generationRecord(NEXT_GENERATION_ID, generationNumber),
            currentReferenceCount: Math.max(
              currentGeneration.currentReferenceCount,
              input.currentReferences ?? 0
            )
          };
          entity = {
            ...entity,
            generationId: NEXT_GENERATION_ID,
            entityId: NEXT_ENTITY_ID,
            slotId: "next-generation-slot"
          };
          return {
            generation: currentGeneration,
            created: true,
            entityIds: [NEXT_ENTITY_ID],
            retiredEntityIds: [ENTITY_ID],
            shortfallByKind: {
              tree: 0,
              deer: 0,
              wolf_pack: 0,
              sap_crawler_group: 0
            }
          };
        }
        return {
          generation: currentGeneration,
          created: false,
          entityIds: [ENTITY_ID],
          shortfallByKind: {
            tree: 0,
            deer: 0,
            wolf_pack: 0,
            sap_crawler_group: 0
          }
        };
      }
      generationNumber += 1;
      const generationId = generationNumber === 1
        ? GENERATION_ID
        : NEXT_GENERATION_ID;
      currentGeneration = generationRecord(generationId, generationNumber);
      return {
        generation: currentGeneration,
        created: true,
        entityIds: [ENTITY_ID],
        shortfallByKind: {
          tree: 0,
          deer: 0,
          wolf_pack: 0,
          sap_crawler_group: 0
        }
      };
    }),
    loadCurrentGenerations: vi.fn(async (
      zoneIds: readonly string[]
    ) => {
      void zoneIds;
      return currentGeneration === null ? [] : [currentGeneration];
    }),
    loadDueCurrentGenerations: vi.fn(async () =>
      currentGeneration === null ? [] : [currentGeneration]
    ),
    updateCurrentGenerationReferences: vi.fn(async (input: {
      references: readonly {
        currentReferences: number;
        unreferencedAt?: Date;
      }[];
    }) => {
      const reference = input.references[0];
      if (currentGeneration !== null && reference !== undefined) {
        currentGeneration = {
          ...currentGeneration,
          currentReferenceCount: reference.currentReferences,
          unreferencedAt: reference.currentReferences > 0
            ? null
            : (reference.unreferencedAt ?? currentGeneration.unreferencedAt)
        };
      }
      return currentGeneration === null ? 0 : 1;
    }),
    markGenerationExpired: vi.fn(async (input: {
      currentReferences: number;
    }) => {
      if (currentGeneration === null) return null;
      currentGeneration = {
        ...currentGeneration,
        status: input.currentReferences > 0
          ? "refresh-pending" as const
          : "expired" as const,
        currentReferenceCount: input.currentReferences
      };
      return currentGeneration;
    }),
    cleanupExpiredGeneration: vi.fn(async () => {
      if (options.cleanupResult !== true) return false;
      currentGeneration = null;
      return true;
    }),
    claimMobCombatProfilesForZones: vi.fn(async (
      requests: readonly {
        zoneId: string;
        level: number;
        source: "zone_player_profile";
      }[]
    ) => {
      const request = requests.find((candidate) => candidate.zoneId === entity.zoneId);
      if (request && entity.combatLevel === undefined) {
        entity = {
          ...entity,
          combatLevel: request.level,
          combatTier: mobChallengeTier(request.level),
          combatBalanceVersion: 2,
          combatProfileSource: request.source
        };
      }
      return request ? 1 : 0;
    }),
    loadReadyEntitiesForZones: vi.fn(async (
      zoneIds: readonly string[]
    ): Promise<PopulationZoneV2ReadyEntity[]> => {
      void zoneIds;
      const generationId = currentGeneration?.generationId ?? GENERATION_ID;
      return [{ ...entity, generationId }, stone];
    }),
    acquireRuntimeEntityLeases: vi.fn(async (
      requests: readonly PopulationZoneV2RuntimeLeaseRequest[],
      leaseMs: number
    ) => requests.map((request) => ({
      ...request,
      ownerToken: "00000000-0000-4000-8000-000000000030",
      fencingGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + leaseMs)
    }))),
    renewRuntimeEntityLeases: vi.fn(async () => [{
      entityId: ENTITY_ID,
      status: "renewed" as const
    }]),
    updateReadyRuntimeEntityState: vi.fn(async () => true),
    rebindRuntimeEntityLease: vi.fn(async (
      _existing: unknown,
      request: PopulationZoneV2RuntimeLeaseRequest,
      leaseMs: number
    ) => ({
      ...request,
      fencingGeneration: 2,
      leaseExpiresAt: new Date(Date.now() + leaseMs)
    })),
    releaseRuntimeEntityLeases: vi.fn(async () => 1)
  };
  const combat = {
    spawnMob: vi.fn((input: { entityId?: string }) =>
      ({ entityId: input.entityId ?? ENTITY_ID } as never)
    ),
    despawnMob: vi.fn((entityId: string) => entityId.length > 0),
    despawnPopulationManagedMob: vi.fn(() => false),
    rebindPopulationAuthority: vi.fn(() => true),
    setPopulationMobRuntimeStateSink: vi.fn((sink: typeof runtimeStateSink) => {
      runtimeStateSink = sink;
    })
  };
  const backend = new PopulationZonesV2Backend(
    store,
    planner,
    combat,
    {
      regionCode: "test",
      runtimeSha: "c".repeat(40),
      worldEnvironmentIdentityKey: "a".repeat(64),
      worldPipelineSha: "b".repeat(40),
      ...(options.generationSweepMs === undefined
        ? {}
        : { generationSweepMs: options.generationSweepMs }),
      ...(options.runtimeLeaseMs === undefined
        ? {}
        : { runtimeLeaseMs: options.runtimeLeaseMs }),
      ...(options.runtimeHeartbeatMs === undefined
        ? {}
        : { runtimeHeartbeatMs: options.runtimeHeartbeatMs })
    },
    options.logger
  );
  return {
    backend,
    store,
    planner,
    combat,
    emitRuntimeState(entityId: string, state: PopulationMobCombatRuntimeState) {
      runtimeStateSink?.(entityId, state);
    },
    get entity() {
      return entity;
    },
    set entity(value: PopulationZoneV2ReadyEntity) {
      entity = value;
    },
    stone,
    generation: () => currentGeneration,
    setGeneration(value: PopulationZoneV2GenerationRecord | null) {
      currentGeneration = value;
    }
  };
}

function challengeProfile(level: number) {
  return {
    currentGearLevel: level,
    unlockedGearLevel: level,
    tier: mobChallengeTier(level),
    contributors: {
      melee: level,
      chest: level,
      secondary: level
    },
    balanceVersion: 2 as const
  };
}

function generationRecord(
  generationId = GENERATION_ID,
  generationNumber = 1
): PopulationZoneV2GenerationRecord {
  const generatedAt = new Date(Date.now() - 60_000);
  return {
    generationId,
    zoneId: ZONE_ID,
    planId: PLAN_ID,
    generationNumber,
    generatedAt,
    expiresAt: new Date(generatedAt.getTime() + 48 * 60 * 60_000),
    status: "active",
    plannedNonStoneCount: 1,
    currentReferenceCount: 0,
    unreferencedAt: null,
    isCurrent: true,
    cleanedAt: null,
    densityRevision: POPULATION_DENSITY_REVISION,
    planContentHash: "ready",
    candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION,
    materializationRevision: POPULATION_GENERATION_MATERIALIZATION_REVISION
  };
}

function expiredGeneration(): PopulationZoneV2GenerationRecord {
  return {
    ...generationRecord(),
    generatedAt: new Date(Date.now() - 49 * 60 * 60_000),
    expiresAt: new Date(Date.now() - 60 * 60_000)
  };
}
