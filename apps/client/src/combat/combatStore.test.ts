import { describe, expect, it } from "vitest";

import { CombatStore, resolveCombatSelection } from "./combatStore.js";

describe("CombatStore", () => {
  it("applies snapshots and monotonic deltas without React state", () => {
    const store = new CombatStore();
    expect(store.applySnapshot(batch(1, [entity("p1", 1, 100)]))).toBe("applied");
    expect(store.applyDelta(batch(2, [entity("p1", 2, 90)]))).toBe("applied");
    expect(store.get("p1")?.currentHealth).toBe(90);
    expect(store.applyDelta(batch(2, [entity("p1", 3, 80)]))).toBe("ignored");
    expect(store.get("p1")?.currentHealth).toBe(90);
  });

  it("removes entities and replaces the complete interest snapshot", () => {
    const store = new CombatStore();
    store.applySnapshot(batch(1, [entity("p1", 1, 100), entity("mob:1", 1, 60)]));
    store.applyDelta({ ...batch(2, []), removedEntityIds: ["mob:1"] });
    expect(store.get("mob:1")).toBeNull();
    store.applySnapshot(batch(3, [entity("p2", 1, 100)]));
    expect(store.entities().map((value) => value.entityId)).toEqual(["p2"]);
  });

  it("resets the sequence epoch for a fresh authoritative connection", () => {
    const store = new CombatStore();
    store.applySnapshot(batch(100, [entity("old", 1, 100)]));
    store.clear();
    expect(store.applySnapshot(batch(1, [entity("new", 1, 100)]))).toBe("applied");
    expect(store.get("old")).toBeNull();
    expect(store.get("new")?.currentHealth).toBe(100);
  });

  it("takes a restarted server stream after a reconnect instead of keeping the stale view", () => {
    // Reconnected while dead: the old socket left sequence 95 and a respawning player at a high revision; the server
    // re-registered the player and restarted its stream at 1 with a fresh, lower entity revision.
    const store = new CombatStore();
    store.applySnapshot(batch(95, [dead("p1", 43)]));
    expect(store.applySnapshot(batch(1, [dead("p1", 6)]))).toBe("applied");
    expect(store.metrics().sequence).toBe(1);
    // The respawn the server then streams must reach the store (the death card closes on it).
    expect(store.applyDelta(batch(2, [entity("p1", 7, 100)]))).toBe("applied");
    expect(store.get("p1")?.lifeState).toBe("alive");
    expect(store.get("p1")?.currentHealth).toBe(100);
  });

  it("detects a missing delta without applying partial state", () => {
    const store = new CombatStore();
    store.applySnapshot(batch(4, [entity("p1", 1, 100), entity("mob:ghost", 1, 60)]));

    expect(store.applyDelta(batch(6, [entity("p1", 2, 90)]))).toBe("gap");
    expect(store.metrics().sequence).toBe(4);
    expect(store.get("p1")?.currentHealth).toBe(100);
    expect(store.get("mob:ghost")).not.toBeNull();

    expect(store.applySnapshot(batch(7, [entity("p1", 3, 90)]))).toBe("applied");
    expect(store.get("mob:ghost")).toBeNull();
  });

  it("does not recreate a removed mob from an old delta and clears its selection", () => {
    const store = new CombatStore();
    store.applySnapshot(batch(4, [entity("p1", 1, 100), entity("mob:1", 1, 10)]));
    store.applyDelta({ ...batch(5, []), removedEntityIds: ["mob:1"] });

    expect(resolveCombatSelection(store, "mob:1")).toEqual({ entityId: null, entity: null });
    expect(store.applyDelta(batch(4, [entity("mob:1", 2, 10)]))).toBe("ignored");
    expect(store.get("mob:1")).toBeNull();
  });

  it("replaces repeated authoritative snapshots without duplicating a wolf identity", () => {
    const store = new CombatStore();
    store.applySnapshot(batch(1, [entity("mob:wolf-slot:flag:0:g1", 1, 60)]));
    store.applySnapshot(batch(2, [entity("mob:wolf-slot:flag:0:g1", 1, 60)]));
    expect(store.entities().map((value) => value.entityId)).toEqual(["mob:wolf-slot:flag:0:g1"]);
  });
});

function entity(entityId: string, revision: number, currentHealth: number) {
  return {
    entityId,
    kind: entityId.startsWith("mob:") ? "mob" as const : "player" as const,
    archetypeKey: entityId.startsWith("mob:") ? "goblin" as const : null,
    name: entityId,
    level: entityId.startsWith("mob:") ? 10 : 0,
    regionCode: "NM",
    zoneId: "world:NM",
    lat: 35.0844,
    lon: -106.6504,
    maxHealth: 100,
    currentHealth,
    lifeState: "alive" as const,
    activityState: "idle" as const,
    targetEntityId: null,
    revision
  };
}

function dead(entityId: string, revision: number) {
  return { ...entity(entityId, revision, 0), lifeState: "respawning" } as unknown as ReturnType<typeof entity>;
}

function batch(sequence: number, upserts: ReturnType<typeof entity>[]) {
  return {
    serverTick: sequence,
    serverTime: sequence,
    sequence,
    upserts,
    removedEntityIds: [],
    events: []
  };
}
