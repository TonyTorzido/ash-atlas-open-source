import { describe, expect, it } from "vitest";
import { destinationPoint, type LatLon } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter } from "./bossFramework.js";
import { DROWNED_CITY_BOSS_SPECS } from "./drownedCityBosses.js";
import {
  createPhasedController,
  MINIBOSS_SPEC,
  PHASED_DUNGEON_BOSS_SPEC,
  validatePhasedBossSpec,
  type PhasedBossSpec
} from "./phasedBossController.js";

const bossPos: LatLon = { lat: 35.0844, lon: -106.6504 };
const playerPos = destinationPoint(bossPos, 60, 90);

function harness(spec: PhasedBossSpec, anchors: Readonly<Record<string, LatLon>> = {}) {
  const state = {
    now: 1_000,
    ratio: 1,
    alive: new Set<string>(),
    spawned: 0,
    despawned: [] as string[],
    moves: [] as LatLon[],
    spawnPositions: [] as (readonly LatLon[] | undefined)[]
  };
  const encounter: BossEncounter = new BossEncounter({
    encounterId: "enc",
    definition: { id: spec.id, revision: 1, archetypeKey: "sewer_rat_miniboss", controllerId: spec.id, rewardPolicy: { id: "x", minimumContribution: 1 } },
    host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "room", encounterId: "e", participantIds: ["p1"] }),
    mobEntityId: "boss",
    controller: createPhasedController(spec, {
      bossHealthRatio: () => state.ratio,
      bossPosition: () => bossPos,
      playerPosition: () => playerPos,
      anchorPosition: (_boss, anchorId) => anchors[anchorId] ?? null,
      spawnAdds: (_boss, _archetype, count, positions) => {
        state.spawnPositions.push(positions);
        const ids = Array.from({ length: count }, () => `add-${++state.spawned}`);
        for (const id of ids) state.alive.add(id);
        return ids;
      },
      isAlive: (id) => state.alive.has(id),
      despawnAdds: (ids) => { for (const id of ids) { state.alive.delete(id); state.despawned.push(id); } },
      moveBossTo: (_boss, position) => { state.moves.push(position); },
      random: () => 0
    }),
    initialState: "active",
    positionOfEntity: () => playerPos,
    now: () => state.now
  });
  const tick = (advanceMs: number) => {
    state.now += advanceMs;
    return encounter.tick(state.now);
  };
  const abilities = () => encounter.activeCasts.map((cast) => cast.abilityId);
  return { state, encounter, tick, abilities };
}

const spec: PhasedBossSpec = {
  id: "t_boss",
  castGapMs: 1_000,
  openingDelayMs: 0,
  enrage: { belowHealthPercent: 20, cooldownScale: 0.5, damageMultiplier: 2 },
  phases: [
    {
      id: "one",
      untilHealthPercent: 70,
      abilities: [
        { kind: "cleave", key: "cleave", cooldownMs: 6_000, weight: 1, rangeM: 120, angleDegrees: 70, telegraphMs: 500 },
        { kind: "slam", key: "slam", cooldownMs: 6_000, weight: 1, radiusM: 150, telegraphMs: 500 }
      ]
    },
    {
      id: "two",
      untilHealthPercent: 0,
      abilities: [
        { kind: "summon", key: "adds", cooldownMs: 30_000, weight: 1, archetype: "slime", count: 2, shieldWhileAlive: true },
        { kind: "charge", key: "charge", cooldownMs: 6_000, weight: 1, lengthM: 450, widthM: 80, telegraphMs: 500 }
      ]
    }
  ]
};

describe("phased boss controller", () => {
  it("rejects malformed specs", () => {
    expect(() => validatePhasedBossSpec({ id: "x", phases: [] })).toThrow();
    expect(() => validatePhasedBossSpec({
      id: "x",
      phases: [{ id: "a", untilHealthPercent: 30, abilities: [] }, { id: "b", untilHealthPercent: 50, abilities: [] }]
    })).toThrow();
    expect(validatePhasedBossSpec(PHASED_DUNGEON_BOSS_SPEC)).toBe(PHASED_DUNGEON_BOSS_SPEC);
    expect(validatePhasedBossSpec(MINIBOSS_SPEC)).toBe(MINIBOSS_SPEC);
  });

  it("enters the first phase on activation and moves on at HP thresholds", () => {
    const h = harness(spec);
    h.encounter.activate();
    expect(h.encounter.phase).toBe("one");
    h.state.ratio = 0.71;
    h.tick(10);
    expect(h.encounter.phase).toBe("one");
    h.state.ratio = 0.7;
    h.tick(10);
    expect(h.encounter.phase).toBe("two");
    // Healing back up never regresses a phase.
    h.state.ratio = 0.95;
    h.tick(10);
    expect(h.encounter.phase).toBe("two");
  });

  it("respects cooldowns and the gap between casts", () => {
    const h = harness(spec);
    h.encounter.activate();
    h.tick(0);
    expect(h.abilities()).toEqual(["dungeon_cone_cleave"]);
    h.tick(500); // resolves
    expect(h.abilities()).toEqual([]);
    h.tick(1_000); // gap elapsed, cleave on cooldown so the slam is the only choice
    expect(h.abilities()).toEqual(["t_boss_slam"]);
    h.tick(500);
    h.tick(1_000); // both on cooldown
    expect(h.abilities()).toEqual([]);
    h.tick(5_000);
    expect(h.abilities()).toEqual(["dungeon_cone_cleave"]);
  });

  it("charges along a telegraphed line and moves the boss when it resolves", () => {
    const h = harness(spec);
    h.encounter.activate();
    h.state.ratio = 0.5;
    h.tick(0); // phase transition
    h.tick(0); // summon first (weight order, random 0)
    h.state.alive.clear(); // adds die, shield drops
    h.tick(1_000);
    expect(h.abilities()).toEqual(["t_boss_charge"]);
    const [cast] = h.encounter.activeCasts;
    expect(cast?.geometry.kind).toBe("line");
    h.tick(500);
    expect(h.state.moves).toHaveLength(1);
  });

  it("shields the boss until its summoned adds die", () => {
    const h = harness(spec);
    h.encounter.activate();
    h.state.ratio = 0.5;
    h.tick(0);
    h.tick(0);
    expect(h.state.alive.size).toBe(2);
    expect(h.encounter.movementOverride).toMatchObject({ incomingDamageMultiplier: 0 });
    h.state.alive.delete("add-1");
    h.tick(10);
    expect(h.encounter.movementOverride).toMatchObject({ incomingDamageMultiplier: 0 });
    h.state.alive.delete("add-2");
    h.tick(10);
    expect(h.encounter.movementOverride).toBeNull();
  });

  it("enrage shortens cooldowns and applies a damage multiplier", () => {
    const h = harness(spec);
    h.encounter.activate();
    h.state.ratio = 0.19;
    h.tick(0);
    expect(h.encounter.phase).toBe("two");
    h.tick(10);
    expect(h.encounter.movementOverride).toMatchObject({ outgoingDamageMultiplier: 2 });
    // Summon fires first and was shielded; kill adds, then the charge cooldown is 3s (6s * 0.5).
    h.state.alive.clear();
    h.tick(500);
    expect(h.abilities()).toEqual(["t_boss_charge"]);
    h.tick(500);
    h.tick(1_900);
    expect(h.abilities()).toEqual([]);
    h.tick(700);
    expect(h.abilities()).toEqual(["t_boss_charge"]);
  });

  it("clears modifiers on reset", () => {
    const h = harness(spec);
    h.encounter.activate();
    h.state.ratio = 0.5;
    h.tick(0);
    h.tick(0);
    expect(h.encounter.movementOverride).not.toBeNull();
    h.encounter.reset();
    expect(h.encounter.movementOverride).toBeNull();
  });

  it("despawns living adds when the boss is defeated", () => {
    const h = harness(spec);
    h.encounter.activate();
    h.state.ratio = 0.5;
    h.tick(0);
    h.tick(0);
    expect(h.state.alive.size).toBe(2);
    h.encounter.defeat();
    expect(h.state.despawned.sort()).toEqual(["add-1", "add-2"]);
    expect(h.state.alive.size).toBe(0);
  });
});

describe("phased boss kit additions (Drowned City)", () => {
  const north = destinationPoint(bossPos, 200, 0);
  const south = destinationPoint(bossPos, 200, 180);
  const dais = destinationPoint(bossPos, 150, 270);
  const kitSpec: PhasedBossSpec = {
    id: "kit_boss",
    castGapMs: 1_000,
    openingDelayMs: 0,
    phases: [
      {
        id: "one",
        untilHealthPercent: 50,
        retreatToAnchor: "dais",
        abilities: [
          { kind: "summon", key: "wave", cooldownMs: 0, weight: 100, oncePerPhase: true, archetype: "slime", count: 3,
            shieldWhileAlive: true, spawnAnchors: ["north", "south"] },
          { kind: "slam", key: "slam", cooldownMs: 2_000, weight: 1, radiusM: 150, telegraphMs: 500 }
        ]
      },
      {
        id: "two",
        untilHealthPercent: 0,
        retreatToAnchor: "dais",
        abilities: [
          { kind: "summon", key: "wave", cooldownMs: 0, weight: 100, oncePerPhase: true, archetype: "slime", count: 1,
            spawnAnchors: ["missing"] },
          { kind: "slam", key: "slam", cooldownMs: 2_000, weight: 1, radiusM: 150, telegraphMs: 500 }
        ]
      }
    ]
  };

  it("K1 spawns adds on their anchors, cycling, and falls back to the ring when one is unknown", () => {
    const h = harness(kitSpec, { north, south, dais });
    h.encounter.activate();
    h.tick(0);
    expect(h.state.spawnPositions[0]).toEqual([north, south, north]);
    h.state.alive.clear();
    h.state.ratio = 0.4;
    h.tick(10);
    h.tick(1_000);
    expect(h.state.spawned).toBe(4);
    expect(h.state.spawnPositions[1]).toBeUndefined();
  });

  it("K2 uses a once-per-phase ability once each time its phase is entered", () => {
    const h = harness(kitSpec, { north, south, dais });
    h.encounter.activate();
    h.tick(0);
    expect(h.state.spawned).toBe(3);
    h.state.alive.clear();
    for (let step = 0; step < 10; step += 1) h.tick(1_000);
    expect(h.state.spawned).toBe(3);
    h.state.ratio = 0.4;
    h.tick(10);
    h.tick(1_000);
    expect(h.state.spawned).toBe(4);
    h.state.alive.clear();
    for (let step = 0; step < 10; step += 1) h.tick(1_000);
    expect(h.state.spawned).toBe(4);
  });

  it("K4 retreats to its anchor on entering each phase", () => {
    const h = harness(kitSpec, { north, south, dais });
    h.encounter.activate();
    h.tick(0);
    expect(h.state.moves).toEqual([dais]);
    h.state.alive.clear();
    h.state.ratio = 0.4;
    h.tick(10);
    expect(h.state.moves).toEqual([dais, dais]);
  });

  it("rejects empty spawn and retreat anchors and accepts the shipped Drowned City specs", () => {
    expect(() => validatePhasedBossSpec({ id: "x", phases: [{ id: "a", untilHealthPercent: 0, abilities: [
      { kind: "summon", key: "s", cooldownMs: 0, archetype: "slime", count: 1, spawnAnchors: [] }
    ] }] })).toThrow();
    expect(() => validatePhasedBossSpec({ id: "x", phases: [{ id: "a", untilHealthPercent: 0, retreatToAnchor: " ", abilities: [] }] })).toThrow();
    for (const shipped of DROWNED_CITY_BOSS_SPECS) expect(validatePhasedBossSpec(shipped)).toBe(shipped);
  });
});

describe("shielded phase presentation", () => {
  it("shows <phase>_shielded while the shielding wave lives without re-entering the phase", () => {
    const shieldSpec: PhasedBossSpec = {
      id: "shield_boss", castGapMs: 1_000, openingDelayMs: 0, shieldedPhaseSuffix: "_shielded",
      phases: [
        { id: "one", untilHealthPercent: 50, retreatToAnchor: "dais", abilities: [
          { kind: "summon", key: "wave", cooldownMs: 0, weight: 100, oncePerPhase: true, archetype: "slime", count: 2, shieldWhileAlive: true },
          { kind: "slam", key: "slam", cooldownMs: 2_000, weight: 1, radiusM: 150, telegraphMs: 500 }
        ] },
        { id: "two", untilHealthPercent: 0, abilities: [
          { kind: "slam", key: "slam", cooldownMs: 2_000, weight: 1, radiusM: 150, telegraphMs: 500 }
        ] }
      ]
    };
    const dais = destinationPoint(bossPos, 100, 0);
    const h = harness(shieldSpec, { dais });
    h.encounter.activate();
    h.tick(0);
    h.tick(10);
    expect(h.encounter.phase).toBe("one_shielded");
    expect(h.state.moves).toEqual([dais]);
    h.state.alive.clear();
    h.tick(10);
    expect(h.encounter.phase).toBe("one");
    for (let step = 0; step < 5; step += 1) h.tick(1_000);
    expect(h.state.spawned).toBe(2);
    expect(h.state.moves).toEqual([dais]);
    h.state.ratio = 0.4;
    h.tick(10);
    expect(h.encounter.phase).toBe("two");
  });
});
