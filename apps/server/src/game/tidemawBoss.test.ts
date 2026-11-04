import { describe, expect, it } from "vitest";
import { destinationPoint, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter } from "./bossFramework.js";
import { createTidemawController, TIDEMAW, TIDEMAW_PHASES } from "./tidemawBoss.js";

const bossPos: LatLon = { lat: 0.01, lon: 0.01 };

function harness(random = () => 0) {
  const state = {
    now: 1_000,
    alive: new Map<string, MobArchetypeKey>(),
    spawned: [] as { id: string; archetype: MobArchetypeKey; anchor: string }[],
    despawned: [] as string[]
  };
  const anchors = new Map<string, LatLon>(TIDEMAW.poolAnchors.map((anchor, index) => [anchor, destinationPoint(bossPos, 200, index * 90)]));
  let next = 0;
  const encounter = new BossEncounter({
    encounterId: "enc",
    definition: { id: "tidemaw", revision: 1, archetypeKey: "tidemaw", controllerId: "tidemaw", rewardPolicy: { id: "x", minimumContribution: 1 } },
    host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "dc_kelp_boss", encounterId: "e", participantIds: ["p1"] }),
    mobEntityId: "boss",
    controller: createTidemawController({
      bossPosition: () => bossPos,
      playerPosition: () => destinationPoint(bossPos, 60, 0),
      anchorPosition: (_boss, anchorId) => anchors.get(anchorId) ?? null,
      spawnTentacle: (_boss, archetype, position) => {
        const id = `t${++next}`;
        const anchor = [...anchors].find(([, point]) => point === position)![0];
        state.alive.set(id, archetype);
        state.spawned.push({ id, archetype, anchor });
        return id;
      },
      isAlive: (id) => state.alive.has(id),
      despawn: (ids) => { for (const id of ids) { state.alive.delete(id); state.despawned.push(id); } },
      random
    }),
    initialState: "active",
    positionOfEntity: () => destinationPoint(bossPos, 60, 0),
    now: () => state.now
  });
  const tick = (ms: number) => { state.now += ms; encounter.tick(state.now); };
  const living = (archetype: MobArchetypeKey) => [...state.alive].filter(([, kind]) => kind === archetype).map(([id]) => id);
  const anchorOf = (id: string) => state.spawned.find((entry) => entry.id === id)!.anchor;
  return { state, encounter, tick, living, anchorOf };
}

describe("Tidemaw", () => {
  it("rises with four pooled tentacles, one marked, and is immune while submerged", () => {
    const h = harness();
    h.encounter.activate();
    expect(h.state.alive.size).toBe(4);
    expect(h.living("tidemaw_tentacle_marked")).toHaveLength(1);
    expect(new Set(h.state.spawned.map((entry) => entry.anchor)).size).toBe(4);
    expect(h.encounter.phase).toBe(TIDEMAW_PHASES.submerged);
    expect(h.encounter.movementOverride).toMatchObject({ incomingDamageMultiplier: 0 });
  });

  it("surfaces for 15 s when the marked tentacle dies, then dives and the mark moves", () => {
    const h = harness();
    h.encounter.activate();
    const [marked] = h.living("tidemaw_tentacle_marked");
    const firstPool = h.anchorOf(marked!);
    h.state.alive.delete(marked!);
    h.tick(10);
    expect(h.encounter.phase).toBe(TIDEMAW_PHASES.surfaced);
    expect(h.encounter.movementOverride).toBeNull();
    h.tick(TIDEMAW.surfacedMs - 20);
    expect(h.encounter.phase).toBe(TIDEMAW_PHASES.surfaced);
    h.tick(20);
    expect(h.encounter.phase).toBe(TIDEMAW_PHASES.submerged);
    expect(h.encounter.movementOverride).toMatchObject({ incomingDamageMultiplier: 0 });
    const [moved] = h.living("tidemaw_tentacle_marked");
    expect(h.anchorOf(moved!)).not.toBe(firstPool);
    // The unmarked tentacle in the new marked pool was replaced, not doubled; the old pool regrows.
    expect(h.state.alive.size).toBe(3);
    h.tick(10);
    h.tick(TIDEMAW.regrowMs);
    expect(h.state.alive.size).toBe(4);
    expect(h.living("tidemaw_tentacle_marked")).toHaveLength(1);
  });

  it("regrows an unmarked tentacle 8 s after it falls, without surfacing the boss", () => {
    const h = harness();
    h.encounter.activate();
    const [unmarked] = h.living("tidemaw_tentacle");
    const pool = h.anchorOf(unmarked!);
    h.state.alive.delete(unmarked!);
    h.tick(10);
    expect(h.encounter.phase).toBe(TIDEMAW_PHASES.submerged);
    h.tick(TIDEMAW.regrowMs - 20);
    expect(h.state.alive.size).toBe(3);
    h.tick(30);
    expect(h.state.alive.size).toBe(4);
    expect(h.anchorOf(h.state.spawned.at(-1)!.id)).toBe(pool);
  });

  it("clears every tentacle on reset and on defeat", () => {
    const h = harness();
    h.encounter.activate();
    h.encounter.reset();
    expect(h.state.alive.size).toBe(0);
    expect(h.encounter.movementOverride).toBeNull();
    const d = harness();
    d.encounter.activate();
    d.encounter.defeat();
    expect(d.state.alive.size).toBe(0);
  });
});
