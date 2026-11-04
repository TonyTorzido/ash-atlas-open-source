import { describe, expect, it, vi } from "vitest";

import type { CombatDefeatSettlementCandidate } from "./combat/combatEngine.js";
import {
  type OverworldBossEventHandler,
  OverworldBossEventRegistry
} from "./overworldBossEvents.js";

describe("OverworldBossEventRegistry", () => {
  it("routes entity and defeat ownership to the registered handler", () => {
    const registry = new OverworldBossEventRegistry();
    const handler = testHandler("xoral", "xoral:", "xoral");
    registry.register(handler);

    expect(registry.handlerForEntity("xoral:event-1")).toBe(handler);
    expect(registry.handlerForEntity("mob:wolf-1")).toBeNull();
    expect(registry.handlerForDefeatCandidate(candidate("xoral"))).toBe(handler);
    expect(registry.handlerForDefeatCandidate(candidate("wolf"))).toBeNull();
  });

  it("does not route a shared archetype to an overworld handler when its host is a dungeon", () => {
    const registry = new OverworldBossEventRegistry();
    const handler = testHandler("xoral", "xoral:", "xoral");
    registry.register(handler);
    const dungeonCandidate = {
      ...candidate("xoral"),
      bossOwnership: {
        bossId: "dungeon-ogre",
        bossRevision: 1,
        encounterHandlerId: "dungeon",
        hostKind: "dungeon" as const,
        hostInstanceId: "instance-1",
        encounterInstanceId: "instance-1:run-1:boss",
        lifeGeneration: 1
      }
    };
    expect(registry.handlerForDefeatCandidate(dungeonCandidate)).toBeNull();
  });

  it("rejects duplicate ids and ambiguous ownership", () => {
    const registry = new OverworldBossEventRegistry();
    registry.register(testHandler("first", "boss:", "xoral"));
    expect(() => registry.register(testHandler("first", "other:", "wolf")))
      .toThrow("Duplicate overworld boss handler id");
    registry.register(testHandler("second", "boss:", "xoral"));

    expect(() => registry.handlerForEntity("boss:1"))
      .toThrow("Ambiguous overworld boss ownership");
    expect(() => registry.handlerForDefeatCandidate(candidate("xoral")))
      .toThrow("Ambiguous overworld boss ownership");
  });

  it("keeps Xoral as the only bespoke reward settlement handler", () => {
    const registry = new OverworldBossEventRegistry();
    expect(() => registry.register(testHandler("other", "other:", "wolf", "xoral_bespoke")))
      .toThrow("Only the Xoral handler");
    expect(() => registry.register(testHandler("xoral", "xoral:", "xoral", "canonical")))
      .toThrow("Xoral handler must use");
    expect(() => registry.register(testHandler("xoral", "xoral:", "xoral", "xoral_bespoke")))
      .not.toThrow();
  });
});

function testHandler(
  handlerId: string,
  entityPrefix: string,
  archetype: string,
  rewardSettlementPolicy: OverworldBossEventHandler["rewardSettlementPolicy"] =
    handlerId === "xoral" ? "xoral_bespoke" : "canonical"
): OverworldBossEventHandler {
  return {
    handlerId,
    rewardSettlementPolicy,
    ownsEntity: (entityId) => entityId.startsWith(entityPrefix),
    ownsDefeatCandidate: (value) => value.mobArchetype === archetype,
    canPlayerAttack: () => true,
    canMobAttack: () => true,
    isSharedCombat: () => true,
    acceptDefeat: vi.fn(async () => true)
  };
}

function candidate(mobArchetype: string): CombatDefeatSettlementCandidate {
  return {
    settlementKey: `settlement:${mobArchetype}`,
    defeatedEntityId: `mob:${mobArchetype}`,
    defeatGeneration: 1,
    eligibleParticipantIds: [],
    contributions: [],
    serverTick: 1,
    mobArchetype: mobArchetype as CombatDefeatSettlementCandidate["mobArchetype"]
  };
}
