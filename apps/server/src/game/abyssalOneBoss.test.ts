import { describe, expect, it } from "vitest";
import { destinationPoint, type LatLon } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter, type BossRoomHooks } from "./bossFramework.js";
import { ABYSSAL_ONE, ABYSSAL_ONE_PHASES, createAbyssalOneController } from "./abyssalOneBoss.js";

const bossPos: LatLon = { lat: 0.01, lon: 0.01 };

function harness() {
  const state = {
    now: 1_000,
    ratio: 1,
    alive: new Set<string>(),
    spawned: 0,
    available: new Map<string, boolean>(),
    objectStates: new Map<string, string>(),
    explosions: [] as string[],
    notices: [] as string[]
  };
  const room: BossRoomHooks = {
    objectAvailable: (id) => state.available.get(id) === true,
    objectState: (id) => state.objectStates.get(id) ?? "intact",
    setObjectAvailable: (id, available) => { state.available.set(id, available); },
    setObjectState: (id, value) => { state.objectStates.set(id, value); },
    notify: (_player, text) => { state.notices.push(text); }
  };
  const encounter = new BossEncounter({
    encounterId: "enc",
    definition: { id: "abyssal_one", revision: 1, archetypeKey: "abyssal_one", controllerId: "abyssal_one", rewardPolicy: { id: "x", minimumContribution: 1 } },
    host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "dc_abyssal_sanctum", encounterId: "e", participantIds: ["p1"], room }),
    mobEntityId: "boss",
    controller: createAbyssalOneController({
      bossHealthRatio: () => state.ratio,
      bossPosition: () => bossPos,
      playerPosition: () => destinationPoint(bossPos, 60, 0),
      anchorPosition: () => destinationPoint(bossPos, 150, 90),
      spawnAdds: (_boss, _archetype, count) => {
        const ids = Array.from({ length: count }, () => `cultist-${++state.spawned}`);
        for (const id of ids) state.alive.add(id);
        return ids;
      },
      isAlive: (id) => state.alive.has(id),
      despawn: (ids) => { for (const id of ids) state.alive.delete(id); },
      explodeOn: (_boss, playerId) => { state.explosions.push(playerId); },
      random: () => 0
    }),
    initialState: "active",
    positionOfEntity: () => destinationPoint(bossPos, 60, 0),
    now: () => state.now
  });
  const tick = (ms: number) => { state.now += ms; encounter.tick(state.now); };
  const firstBomb = () => ABYSSAL_ONE.bombObjectIds.find((id) => state.available.get(id) === true) ?? null;
  return { state, encounter, tick, firstBomb };
}

describe("The Abyssal One", () => {
  it("rituals at 80/55/30% call three cultists with a deadline; killing all breaks the ritual", () => {
    const h = harness();
    h.encounter.activate();
    h.tick(10);
    expect(h.state.spawned).toBe(0);
    h.state.ratio = 0.79;
    h.tick(10);
    expect(h.state.alive.size).toBe(3);
    expect(h.encounter.phase).toBe(ABYSSAL_ONE_PHASES.ritual);
    expect(h.encounter.phaseDeadlineAt).toBe(h.state.now + ABYSSAL_ONE.ritualDeadlineMs);
    h.state.alive.clear();
    h.tick(10);
    expect(h.encounter.phaseDeadlineAt).toBeNull();
    expect(h.encounter.phase).toBe(ABYSSAL_ONE_PHASES.awakened);
    expect(h.encounter.failureRequested).toBeNull();
    // One ritual per threshold.
    h.tick(10);
    expect(h.state.spawned).toBe(3);
    h.state.ratio = 0.5;
    h.tick(10);
    expect(h.state.spawned).toBe(6);
  });

  it("a missed ritual deadline asks the host to fail the encounter (K3)", () => {
    const h = harness();
    h.encounter.activate();
    h.state.ratio = 0.7;
    h.tick(10);
    h.tick(ABYSSAL_ONE.ritualDeadlineMs - 20);
    expect(h.encounter.failureRequested).toBeNull();
    h.tick(20);
    expect(h.encounter.failureRequested).toBe("ritual_completed");
  });

  it("tide bombs: one appears every 20 s; picked up and planted on an arm it weakens the boss 15% a stack, max 3", () => {
    const h = harness();
    h.encounter.activate();
    h.tick(ABYSSAL_ONE.firstBombMs);
    const bomb = h.firstBomb()!;
    expect(bomb).not.toBeNull();
    // An arm without a bomb does nothing.
    h.encounter.objectInteract("p1", "abyssal_arm_nw");
    expect(h.state.objectStates.get("abyssal_arm_nw")).toBeUndefined();
    h.encounter.objectInteract("p1", bomb);
    expect(h.state.available.get(bomb)).toBe(false);
    h.encounter.objectInteract("p1", "abyssal_arm_nw");
    expect(h.state.objectStates.get("abyssal_arm_nw")).toBe("destroyed");
    expect(h.encounter.movementOverride).toMatchObject({ outgoingDamageMultiplier: 0.85 });
    expect(h.encounter.phase).toBe(ABYSSAL_ONE_PHASES.weakened);
    // A planted arm cannot take a second bomb; three arms cap the stacks.
    for (const arm of ["abyssal_arm_nw", "abyssal_arm_ne", "abyssal_arm_sw", "abyssal_arm_se"]) {
      h.tick(ABYSSAL_ONE.bombIntervalMs);
      const next = h.firstBomb();
      if (!next) break;
      h.encounter.objectInteract("p1", next);
      h.encounter.objectInteract("p1", arm);
    }
    expect(h.encounter.movementOverride?.outgoingDamageMultiplier).toBeCloseTo(1 - 0.15 * 3);
    expect([...h.state.objectStates.values()].filter((value) => value === "destroyed")).toHaveLength(3);
  });

  it("a carried bomb explodes on its carrier after 15 s, and reset clears bombs, arms, stacks and cultists", () => {
    const h = harness();
    h.encounter.activate();
    h.tick(ABYSSAL_ONE.firstBombMs);
    h.encounter.objectInteract("p1", h.firstBomb()!);
    h.tick(ABYSSAL_ONE.carryMs - 20);
    expect(h.state.explosions).toEqual([]);
    h.tick(30);
    expect(h.state.explosions).toEqual(["p1"]);
    // Late planting after the explosion does nothing.
    h.encounter.objectInteract("p1", "abyssal_arm_se");
    expect(h.state.objectStates.get("abyssal_arm_se")).toBeUndefined();

    h.tick(ABYSSAL_ONE.bombIntervalMs);
    h.encounter.objectInteract("p1", h.firstBomb()!);
    h.encounter.objectInteract("p1", "abyssal_arm_se");
    h.state.ratio = 0.7;
    h.tick(10);
    expect(h.state.alive.size).toBe(3);
    h.encounter.reset();
    expect(h.state.alive.size).toBe(0);
    expect(h.state.objectStates.get("abyssal_arm_se")).toBe("intact");
    expect(ABYSSAL_ONE.bombObjectIds.every((id) => h.state.available.get(id) === false)).toBe(true);
    expect(h.encounter.movementOverride).toBeNull();
    expect(h.encounter.phaseDeadlineAt).toBeNull();
  });
});
