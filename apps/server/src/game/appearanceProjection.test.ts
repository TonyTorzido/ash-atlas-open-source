import type {
  EquipmentInstanceV2,
  EquipmentSnapshotV2
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { installAuthoritativePlayerAppearance } from "./appearanceProjection.js";
import type { CombatInterestFrame } from "./combat/combatEngine.js";
import { GameState } from "./state.js";
import { WorldReplicationService } from "./worldReplication.js";

describe("authoritative appearance state", () => {
  it("installs a monotonic projection and replicates appearance changes as full AOI upserts", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "Local");
    state.helloPlayer("p2", "Remote");
    const replication = new WorldReplicationService(state);
    const interest = visible("p1", "p2");
    replication.snapshotForPlayer("p1", interest);

    const installed = installAuthoritativePlayerAppearance(
      state,
      equipment("p2", 3, "melee")
    )!;
    expect(installed).toMatchObject({
      revision: 3,
      activeHand: "melee",
      bodyVariantId: "default",
      poseId: "idle"
    });
    expect(installed.slots.ring).toBeUndefined();
    expect(replication.deltaForPlayer("p1", interest)?.upserts).toEqual([
      expect.objectContaining({
        kind: "full",
        player: expect.objectContaining({
          playerId: "p2",
          appearance: expect.objectContaining({ revision: 3 })
        })
      })
    ]);

    const next = state.setPlayerAppearance("p2", {
      ...installed,
      revision: 1,
      activeHand: "secondary"
    })!;
    expect(next.revision).toBe(4);
    expect(state.snapshotForPlayer("p2").appearance).toEqual(next);
  });

  it("keeps projected appearance private to the owning player record", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "One");
    state.helloPlayer("p2", "Two");
    installAuthoritativePlayerAppearance(state, equipment("p1", 1, "melee"));

    expect(state.getPlayer("p1")?.appearance).toBeDefined();
    expect(state.getPlayer("p2")?.appearance).toBeUndefined();
  });

  it("preserves the single body template across equipment projections", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "Local");
    state.helloPlayer("p2", "Remote");
    installAuthoritativePlayerAppearance(state, equipment("p2", 1, "melee"));
    const projected = installAuthoritativePlayerAppearance(
      state,
      equipment("p2", 3, "secondary")
    )!;
    expect(projected.bodyVariantId).toBe("default");
  });
});

function equipment(
  playerId: string,
  activeRevision: number,
  readiedWeaponSlot: "melee" | "secondary"
): EquipmentSnapshotV2 {
  const sword = {
    definitionId: "starter_sword",
    category: "melee_weapon"
  } as EquipmentInstanceV2;
  const bow = {
    definitionId: "starter_bow",
    category: "ranged_weapon"
  } as EquipmentInstanceV2;
  return {
    playerId,
    activeRevision,
    readiedWeaponSlot,
    active: {
      head: null,
      chest: null,
      gloves: null,
      boots: null,
      ring: { definitionId: "training_ring", category: "ring" } as EquipmentInstanceV2,
      melee: sword,
      secondary: bow
    }
  } as EquipmentSnapshotV2;
}

function visible(localId: string, remoteId: string): CombatInterestFrame {
  return {
    nearbyIdsByPlayer: new Map([[localId, new Set([localId, remoteId])]]),
    cacheHits: 0,
    cacheMisses: 1
  };
}
