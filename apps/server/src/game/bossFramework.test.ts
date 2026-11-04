import { describe, expect, it, vi } from "vitest";

import {
  BossControllerRegistry,
  BossDefinitionRegistry,
  BossEncounter,
  BossEncounterManager,
  DungeonBossHostAdapter,
  IdempotentBossRewardAdapter,
  OverworldBossHostAdapter,
  type BossController,
  type BossHostAdapter
} from "./bossFramework.js";

const definition = {
  id: "test-boss",
  revision: 1,
  archetypeKey: "ogre" as const,
  controllerId: "cone",
  rewardPolicy: { id: "test-reward", minimumContribution: 1 }
};
const origin = { lat: 35, lon: -106 };

function host(input: Partial<ConstructorParameters<typeof OverworldBossHostAdapter>[0]> = {}): BossHostAdapter {
  return new OverworldBossHostAdapter({
    hostInstanceId: "world-1",
    encounterHandlerId: "test-handler",
    participationPolicyId: "locked-roster",
    participantIds: ["p1", "p2"],
    ...input
  });
}

describe("BossEncounter", () => {
  it("owns casts by life generation and cancels stale work on reset/defeat", () => {
    const controller: BossController = {};
    const encounter = new BossEncounter({
      encounterId: "encounter-1",
      definition,
      host: host(),
      mobEntityId: "mob:one",
      controller,
      initialState: "dormant",
      initialPhaseId: "phase-1",
      now: () => 1_000
    });
    expect(encounter.activate()).toBe(true);
    const cast = encounter.beginCast({
      abilityId: "cleave",
      castDurationMs: 500,
      geometry: { kind: "circle", center: { lat: 35, lon: -106 }, radiusM: 10 }
    });
    expect(cast?.lifeGeneration).toBe(0);
    expect(encounter.activeCasts).toHaveLength(1);
    expect(encounter.reset()).toBe(true);
    expect(encounter.activeCasts).toHaveLength(0);
    expect(encounter.lifeGeneration).toBe(1);
    expect(encounter.tick(10_000).resolved).toHaveLength(0);
    expect(encounter.activate()).toBe(true);
    expect(encounter.defeat()).toBe(true);
    expect(encounter.beginCast({
      abilityId: "after-death",
      castDurationMs: 1,
      geometry: { kind: "circle", center: { lat: 35, lon: -106 }, radiusM: 10 }
    })).toBeNull();
  });

  it("resolves the same authoritative geometry against eligible participants", () => {
    const hits: string[] = [];
    const positionById = new Map([
      ["p1", { lat: 35.001, lon: -106 }],
      ["p2", { lat: 35, lon: -105.998 }]
    ]);
    const encounter = new BossEncounter({
      encounterId: "encounter-2",
      definition,
      host: host({ participantIds: ["p1", "p2"] }),
      mobEntityId: "mob:two",
      controller: {},
      initialState: "active",
      now: () => 1_000
    });
    encounter.beginCast({
      abilityId: "cone-cleave",
      castInstanceId: "cast-1",
      startTime: 1_000,
      resolveTime: 2_000,
      geometry: { kind: "cone", origin: { lat: 35, lon: -106 }, facingDegrees: 0, rangeM: 200, angleDegrees: 90 }
    });
    const result = encounter.tick(2_000, {
      positionOfEntity: (entityId) => positionById.get(entityId) ?? null,
      applyHit: (_cast, playerId) => hits.push(playerId)
    });
    expect(result.resolved[0]?.hitParticipantIds).toEqual(["p1"]);
    expect(hits).toEqual(["p1"]);
    expect(encounter.projection(2_000).activeCasts).toEqual([]);
  });

  it("rejects a cast target that is not currently eligible", () => {
    const encounter = new BossEncounter({
      encounterId: "encounter-target",
      definition,
      host: host({ participantIds: ["p1"] }),
      mobEntityId: "mob:target",
      controller: {},
      initialState: "active",
      now: () => 1_000
    });
    expect(encounter.beginCast({
      abilityId: "invalid-target",
      targetEntityId: "p2",
      castDurationMs: 100,
      geometry: { kind: "circle", center: origin, radiusM: 10 }
    })).toBeNull();
  });

  it("uses the authoritative tick time for controller-created casts", () => {
    const encounter = new BossEncounter({
      encounterId: "encounter-tick-time",
      definition,
      host: host({ participantIds: ["p1"] }),
      mobEntityId: "mob:tick-time",
      controller: {
        update: (context) => {
          if (context.encounter.activeCasts.length === 0) {
            context.beginCast({
              abilityId: "tick-time",
              castDurationMs: 100,
              geometry: { kind: "circle", center: origin, radiusM: 10 }
            });
          }
        }
      },
      initialState: "active",
      now: () => 1_000
    });
    encounter.tick(5_000);
    expect(encounter.activeCasts[0]?.startTime).toBe(5_000);
    expect(encounter.activeCasts[0]?.resolveTime).toBe(5_100);
  });

  it("rejects a cast submitted by a controller context from an older life", () => {
    const contexts: Parameters<NonNullable<BossController["onActivate"]>>[0][] = [];
    const encounter = new BossEncounter({
      encounterId: "encounter-stale-context",
      definition,
      host: host({ participantIds: ["p1"] }),
      mobEntityId: "mob:stale-context",
      controller: {
        onActivate: (context) => { contexts.push(context); }
      },
      initialState: "dormant",
      now: () => 1_000
    });
    expect(encounter.activate()).toBe(true);
    const staleContext = contexts[0];
    expect(staleContext?.lifeGeneration).toBe(0);
    expect(encounter.reset()).toBe(true);
    expect(encounter.activate()).toBe(true);
    expect(staleContext?.beginCast({
      abilityId: "stale",
      castDurationMs: 100,
      geometry: { kind: "circle", center: origin, radiusM: 10 }
    })).toBeNull();
  });

  it("creates isolated dungeon hosts for separate instances and runs", () => {
    const first = new DungeonBossHostAdapter({
      instanceId: "instance-a", runId: "run-a", roomId: "room-boss", encounterId: "enc-1",
      participantIds: ["p1"]
    });
    first.setParticipantContext("p2", { instanceId: "instance-b", runId: "run-b", roomId: "room-boss" });
    expect(first.getEligibleParticipants()).toEqual(["p1"]);
    expect(first.canParticipate("p2")).toBe(false);
    const second = new DungeonBossHostAdapter({
      instanceId: "instance-b", runId: "run-b", roomId: "room-boss", encounterId: "enc-1",
      participantIds: ["p2"]
    });
    expect(second.encounterInstanceId).not.toBe(first.encounterInstanceId);
  });
});

describe("BossEncounterManager", () => {
  it("routes explicit ownership independently of combat archetype", () => {
    const definitions = new BossDefinitionRegistry();
    definitions.register(definition);
    const controllers = new BossControllerRegistry();
    controllers.register("cone", () => ({}));
    const manager = new BossEncounterManager(definitions, controllers);
    const encounter = manager.create({
      encounterId: "encounter-manager",
      definitionId: definition.id,
      host: host(),
      mobEntityId: "mob:shared-archetype",
      initialState: "active"
    });
    expect(manager.ownsDefeatCandidate({
      defeatedEntityId: encounter.mobEntityId,
      bossOwnership: encounter.ownership()
    })).toBe(true);
    expect(manager.ownsDefeatCandidate({
      defeatedEntityId: encounter.mobEntityId,
      bossOwnership: { ...encounter.ownership(), encounterInstanceId: "other" }
    })).toBe(false);
  });

  it("runs an isolated dungeon cone cast, authorizes hits, and clears on wipe reset", async () => {
    const definitions = new BossDefinitionRegistry();
    const dungeonDefinition = {
      ...definition,
      id: "dungeon-fixture",
      controllerId: "dungeon-fixture"
    } as const;
    definitions.register(dungeonDefinition);
    const controllers = new BossControllerRegistry();
    controllers.register("dungeon-fixture", () => ({
      update: (tick) => {
        if (tick.encounter.activeCasts.length > 0) return;
        tick.beginCast({
          abilityId: "cone-cleave",
          geometry: {
            kind: "cone",
            origin,
            facingDegrees: 0,
            rangeM: 200,
            angleDegrees: 90
          },
          castDurationMs: 100
        });
      }
    }));
    const positions = new Map([
      ["p1", { lat: 35.001, lon: -106 }],
      ["p2", { lat: 35, lon: -105.998 }]
    ]);
    const hits: string[] = [];
    const manager = new BossEncounterManager(definitions, controllers, {
      now: () => 1_000,
      resolver: {
        positionOfEntity: (entityId) => positions.get(entityId) ?? null,
        applyHit: (_cast, participantId) => hits.push(participantId)
      }
    });
    const firstHost = new DungeonBossHostAdapter({
      instanceId: "instance-a", runId: "run-a", roomId: "boss-room", encounterId: "enc-a",
      participantIds: ["p1"]
    });
    const encounter = manager.create({
      encounterId: "instance-a:run-a:enc-a",
      definitionId: dungeonDefinition.id,
      host: firstHost,
      mobEntityId: "mob:dungeon-a",
      initialState: "active"
    });
    manager.tick(1_000);
    expect(encounter.activeCasts).toHaveLength(1);
    manager.tick(1_100);
    expect(hits).toEqual(["p1"]);
    expect(manager.projectionForEntity("mob:dungeon-a")?.activeCasts).toEqual([]);
    expect(manager.reset(encounter.encounterId)).toBe(true);
    expect(encounter.activeCasts).toHaveLength(0);
    expect(manager.ownsDefeatCandidate({
      defeatedEntityId: encounter.mobEntityId,
      bossOwnership: encounter.ownership()
    })).toBe(false);
    const progressionHost = new DungeonBossHostAdapter({
      instanceId: "instance-a", runId: "run-a", roomId: "boss-room", encounterId: "enc-defeat",
      participantIds: ["p1"]
    });
    const progressionEncounter = manager.create({
      encounterId: "instance-a:run-a:enc-defeat",
      definitionId: dungeonDefinition.id,
      host: progressionHost,
      mobEntityId: "mob:dungeon-defeat",
      initialState: "active"
    });
    const progression = vi.fn(async () => true);
    await expect(manager.acceptDefeatCandidate({
      settlementKey: "dungeon-defeat-1",
      defeatedEntityId: progressionEncounter.mobEntityId,
      defeatGeneration: progressionEncounter.lifeGeneration,
      eligibleParticipantIds: ["p1"],
      contributions: [{ entityId: "p1", damage: 10 }],
      serverTick: 1,
      mobArchetype: "ogre",
      bossOwnership: progressionEncounter.ownership()
    }, async () => progression())).resolves.toBe(true);
    expect(progression).toHaveBeenCalledOnce();
    expect(progressionEncounter.lifecycleState).toBe("defeated");
    const secondHost = new DungeonBossHostAdapter({
      instanceId: "instance-b", runId: "run-b", roomId: "boss-room", encounterId: "enc-a",
      participantIds: ["p2"]
    });
    expect(secondHost.encounterInstanceId).not.toBe(firstHost.encounterInstanceId);
  });
});

describe("IdempotentBossRewardAdapter", () => {
  it("settles each key once and coalesces concurrent retries", async () => {
    const adapter = new IdempotentBossRewardAdapter();
    const settle = vi.fn(async () => true);
    await Promise.all([adapter.settle("key", settle), adapter.settle("key", settle)]);
    await adapter.settle("key", settle);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(adapter.hasSettled("key")).toBe(true);
  });
});
