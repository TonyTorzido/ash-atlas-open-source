import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { distanceMeters, moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import {
  BROOD_MATRIARCH,
  BROOD_MATRIARCH_ABILITIES,
  BROOD_MATRIARCH_PHASES,
  createBroodMatriarchController
} from "./broodMatriarchBoss.js";
import { BossEncounter, DungeonBossHostAdapter } from "./bossFramework.js";
import { createCoreBossRuntime } from "./coreBossRuntime.js";
import { CombatEngine } from "./combat/combatEngine.js";
import { SPIDERLING_RETREAT } from "./combat/mobSpecialBehaviors.js";

type Room = {
  id: string;
  anchors: Array<{ id: string; x: number; y: number }>;
  mobs: Array<Record<string, unknown>>;
};
type Catalog = {
  rooms: Room[];
  modules: { encounters: Array<{ id: string; bossTemplateId?: string; waves: Array<{ mobSpawnIds: string[] }> }> };
};
const cityCatalog = JSON.parse(readFileSync(
  new URL("../../../../packages/shared/src/data/interiors/cistern_warrens.json", import.meta.url),
  "utf8"
)) as Catalog;

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);

const definition = {
  id: "brood_matriarch",
  revision: 1,
  archetypeKey: "brood_matriarch" as const,
  controllerId: "brood_matriarch",
  rewardPolicy: { id: "brood_matriarch", minimumContribution: 1 }
};

function makeEncounter(brood: { count: number }, now: () => number) {
  return new BossEncounter({
    encounterId: "i:r:brood-boss:1:boss",
    definition,
    host: new DungeonBossHostAdapter({
      instanceId: "i", runId: "r", roomId: "brood_chamber", encounterId: "brood-boss:1:boss",
      participantIds: ["p1", "p2"]
    }),
    mobEntityId: "mob:matriarch",
    controller: createBroodMatriarchController({
      livingBroodCount: () => brood.count,
      playerPosition: (id) => (id === "p1" ? origin : east(500))
    }),
    initialState: "active",
    now
  });
}

describe("Brood Matriarch controller", () => {
  it("telegraphs a web snare circle and only roots players standing inside it when it lands", () => {
    let now = 1_000;
    const encounter = makeEncounter({ count: 0 }, () => now);
    const rooted: string[] = [];
    const resolver = {
      positionOfEntity: (id: string) => (id === "p1" ? origin : east(500)),
      applyHit: (_cast: unknown, id: string) => { rooted.push(id); }
    };
    encounter.activate();
    now += BROOD_MATRIARCH.firstSnareDelayMs;
    encounter.tick(now, resolver);
    const casts = encounter.projection(now).activeCasts ?? [];
    expect(casts).toHaveLength(1);
    expect(casts[0]).toMatchObject({ abilityId: BROOD_MATRIARCH_ABILITIES.webSnare, geometry: { kind: "circle" } });
    expect(rooted).toEqual([]);

    // Whoever it picked, the circle sits on that player; the other player is 500m away and stays clear.
    const geometry = casts[0]!.geometry as { kind: "circle"; center: LatLon; radiusM: number };
    const caught = ["p1", "p2"].filter((id) =>
      distanceMeters(geometry.center, id === "p1" ? origin : east(500)) <= geometry.radiusM);
    now += BROOD_MATRIARCH.snareTelegraphMs;
    encounter.tick(now, resolver);
    expect(caught).toHaveLength(1);
    expect(rooted).toEqual(caught);
  });

  it("shields the matriarch while spiderlings live and drops the shield when they are gone", () => {
    let now = 1_000;
    const brood = { count: 3 };
    const encounter = makeEncounter(brood, () => now);
    encounter.activate();
    now += 100;
    encounter.tick(now);
    expect(encounter.phase).toBe(BROOD_MATRIARCH_PHASES.shielded);
    expect(encounter.movementOverride).toMatchObject({ incomingDamageMultiplier: BROOD_MATRIARCH.shieldIncomingMultiplier });
    brood.count = 0;
    now += 100;
    encounter.tick(now);
    expect(encounter.phase).toBe(BROOD_MATRIARCH_PHASES.normal);
    expect(encounter.movementOverride).toBeNull();
  });
});

describe("Brood Matriarch dungeon wiring", () => {
  it("summons 3 spiderlings at 50% and 4 at 25% from points along the chamber wall", () => {
    const room = cityCatalog.rooms.find((candidate) => candidate.id === "brood_chamber")!;
    const boss = room.mobs.find((mob) => mob.id === "brood-boss")!;
    expect(boss.archetype).toBe("brood_matriarch");
    const summons = room.mobs.filter((mob) => mob.summonedByMobSpawnId === "brood-boss");
    const at = (percent: number) => summons.filter((mob) => mob.summonAtHealthPercent === percent);
    expect(at(50)).toHaveLength(3);
    expect(at(25)).toHaveLength(4);
    for (const mob of summons) {
      expect(mob.archetype).toBe("spiderling");
      const anchor = room.anchors.find((candidate) => candidate.id === mob.anchorId)!;
      const radius = Math.hypot(anchor.x - 700, anchor.y - 700);
      expect(radius).toBeGreaterThan(400);
      expect(radius).toBeLessThan(610);
    }
    const encounter = cityCatalog.modules.encounters.find((candidate) => candidate.id === "brood-boss")!;
    expect(encounter.bossTemplateId).toBe("brood-matriarch");
    expect(encounter.waves[0]!.mobSpawnIds)
      .toEqual(expect.arrayContaining(["brood-boss", ...summons.map((mob) => mob.id as string)]));
  });
});

describe("Brood Matriarch in the combat engine", () => {
  const createEngine = () => new CombatEngine({ tickRateHz: 20, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true });
  const addPlayer = (engine: CombatEngine, damage = 5) => engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: "NM", zoneId: "world:NM", position: origin,
    accountId: "a", connectionId: "c",
    profile: { playerId: "p1", maxHealth: 5_000, currentHealth: 5_000, baseAttackDamage: damage }
  });
  const spawn = (engine: CombatEngine, archetype: MobArchetypeKey, id: string, at: LatLon) => engine.spawnMob({
    entityId: id, archetype, position: at, homePosition: at, regionCode: "NM", zoneId: "world:NM", worldAi: false
  });
  const engage = (engine: CombatEngine, id: string) => engine.startAttack({
    attackerId: "p1", targetEntityId: id, requestId: `engage:${id}`, accountId: "a", connectionId: "c"
  });

  it("the web snare cast roots a player through the registered boss runtime", () => {
    const engine = createEngine();
    addPlayer(engine);
    const boss = spawn(engine, "brood_matriarch", "boss:1", east(300));
    let now = 1_000;
    const manager = createCoreBossRuntime(engine, 40, () => now);
    manager.create({
      encounterId: "i:r:brood-boss:1:boss",
      definitionId: "brood_matriarch",
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "brood_chamber", encounterId: "brood-boss:1:boss", participantIds: ["p1"] }),
      mobEntityId: boss.entityId,
      initialState: "active",
      lifeGeneration: 1
    });
    now += BROOD_MATRIARCH.firstSnareDelayMs;
    manager.tick(now);
    expect(engine.entity("p1")?.controlEffects ?? []).toEqual([]);
    now += BROOD_MATRIARCH.snareTelegraphMs;
    manager.tick(now);
    expect((engine.entity("p1")?.controlEffects ?? []).some((effect) => effect.kind === "rooted")).toBe(true);
  });

  it("the matriarch bite always poisons", () => {
    const engine = createEngine();
    addPlayer(engine);
    const boss = spawn(engine, "brood_matriarch", "boss:poison", east(60));
    engage(engine, boss.entityId);
    for (let tick = 0; tick <= 60; tick += 1) engine.tick();
    expect(engine.entity("p1")?.harmfulStatusIds ?? []).toContain("poison");
  });

  it("a spiderling below 30% health retreats to the matriarch", () => {
    const engine = createEngine();
    addPlayer(engine, 1);
    spawn(engine, "brood_matriarch", "boss:guard", east(500));
    const spiderling = spawn(engine, "spiderling", "spiderling:1", east(90));
    // A hit that leaves it under 30% health triggers the same hook the damage path calls.
    const internals = engine as unknown as {
      entities: Map<string, { currentHealth: number; maxHealth: number }>;
      processSpiderlingRetreat(mob: unknown): void;
    };
    const entity = internals.entities.get(spiderling.entityId)!;
    entity.currentHealth = Math.max(1, Math.floor(entity.maxHealth * 0.25));
    internals.processSpiderlingRetreat(entity);
    for (let tick = 0; tick < 400; tick += 1) engine.tick();
    const moved = engine.entity(spiderling.entityId)!;
    expect(moved.lifeState).toBe("alive");
    expect(distanceMeters({ lat: moved.lat, lon: moved.lon }, east(500)))
      .toBeLessThanOrEqual(SPIDERLING_RETREAT.arriveDistanceM + 5);
  });
});
