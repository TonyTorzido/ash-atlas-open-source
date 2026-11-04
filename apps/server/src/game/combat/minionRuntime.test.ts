import { describe, expect, it, vi } from "vitest";

import type { CombatEngine } from "./combatEngine.js";
import { isDisplaceable, MinionError, MinionRuntime } from "./minionRuntime.js";

describe("MinionRuntime", () => {
  it("grows treants up to the Grove Lore rank with a regrow cooldown", () => {
    const { runtime } = harness();
    expect(() => runtime.growTreant("p1", "duskroot", 0, 0)).toThrow(MinionError);
    runtime.growTreant("p1", "duskroot", 2, 0);
    expect(() => runtime.growTreant("p1", "mendbark", 2, 10_000)).toThrow(/grow another treant/u);
    runtime.growTreant("p1", "mendbark", 2, 70_000);
    runtime.growTreant("p1", "fernguard", 2, 140_000);
    expect(() => runtime.growTreant("p1", "redwood", 2, 210_000)).toThrow(/keep 3 treants/u);
    expect(runtime.snapshot("p1").map((minion) => minion.species)).toEqual(["treant_duskroot", "treant_mendbark", "treant_fernguard"]);
  });

  it("lets rank 1, 2 and 3 control exactly 1, 3 and 4 tree companions", () => {
    for (const rank of [1, 2, 3]) {
      const { runtime } = harness();
      const kinds = ["duskroot", "fernguard", "mendbark", "redwood"] as const;
      let grown = 0;
      for (const kind of kinds) {
        try { runtime.growTreant("p1", kind, rank, grown * 70_000); grown += 1; } catch (error) { expect(error).toBeInstanceOf(MinionError); }
      }
      const expected = [0, 1, 3, 4][rank]!;
      expect(grown).toBe(expected);
      expect(runtime.count("p1", (species) => species.startsWith("treant_"))).toBe(expected);
    }
  });

  it("Dusk Elderbark poisons what it hits and Elder Fern Hones what attacks it", () => {
    const { runtime, entities, combat } = harness();
    runtime.growTreant("p1", "duskroot", 2, 0);
    runtime.growTreant("p1", "fernguard", 2, 70_000);
    entities.set("mob-1", { entityId: "mob-1", kind: "mob", lifeState: "alive", lat: 0, lon: 0.00002,
      regionCode: "r", zoneId: "z", companion: null, npcFaction: null, maxHealth: 50, currentHealth: 50 });
    const [dusk, fern] = [...entities.keys()].filter((id) => id.startsWith("minion:"));
    entities.get("p1")!.targetEntityId = "mob-1";
    entities.get("mob-1")!.targetEntityId = fern;
    combat.nearbyEntityIds.mockReturnValue(["mob-1"] as never);
    runtime.update("p1", 71_000);
    runtime.update("p1", 73_000);
    expect(combat.applyPetEffect).toHaveBeenCalledWith(dusk, "mob-1", "poison", 1);
    expect(combat.applyPetEffect).toHaveBeenCalledWith(fern, "mob-1", "whetted_attack", 52_000, 4);
  });

  it("levels one Bone Thrall to 5, then a maxed thrall lets the next kill raise a second", () => {
    const { runtime, combat } = harness();
    runtime.recordBonewroughtKill("p1", 0);
    for (let kill = 0; kill < 4; kill += 1) runtime.recordBonewroughtKill("p1", 0);
    expect(runtime.snapshot("p1")).toEqual([expect.objectContaining({ species: "bone_thrall", level: 5 })]);
    expect(combat.rescaleCompanionHealth).toHaveBeenLastCalledWith(expect.any(String), 280 / 60);
    runtime.recordBonewroughtKill("p1", 0);
    expect(runtime.count("p1", (species) => species === "bone_thrall")).toBe(2);
  });

  it("raises the Grave Echo where its owner fell and lets only the echo act while the owner is down", () => {
    const { runtime, entities, combat } = harness();
    runtime.recordBonewroughtKill("p1", 0);
    entities.get("p1")!.lifeState = "defeated";
    expect(runtime.recordBonewroughtDeath("p1", 1, 0)).toBe(true);
    expect(runtime.snapshot("p1").map((minion) => minion.species)).toEqual(["bone_thrall", "grave_echo"]);
    entities.set("mob-1", { entityId: "mob-1", kind: "mob", lifeState: "alive", lat: 0, lon: 0.00002,
      regionCode: "r", zoneId: "z", companion: null, npcFaction: null, maxHealth: 50, currentHealth: 50 });
    combat.nearbyEntityIds.mockReturnValue(["mob-1"] as never);
    runtime.update("p1", 1_000);
    expect(combat.applyScriptedDamage).toHaveBeenCalledTimes(1);
    expect(combat.applyScriptedDamage.mock.calls[0]).toEqual(["p1", "mob-1", 5, "minion_grave_echo", expect.stringContaining("minion:")]);
  });

  it("follows the owner into a dungeon interior instead of snapping back to world regions", () => {
    const { runtime, entities, combat } = harness();
    runtime.recordBonewroughtKill("p1", 0);
    Object.assign(entities.get("p1")!, { regionCode: "interior:dungeon:crypt:player:p1", zoneId: "interior:dungeon:crypt:player:p1:hall" });
    runtime.update("p1", 1_000);
    expect(combat.relocateCompanion).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object),
      expect.objectContaining({ regionCode: "interior:dungeon:crypt:player:p1" }));
    const thrall = [...entities.values()].find((entity) => String(entity.entityId).startsWith("minion:"))!;
    expect(thrall.regionCode).toBe("interior:dungeon:crypt:player:p1");
    combat.relocateCompanion.mockClear();
    runtime.update("p1", 1_200);
    expect(combat.relocateCompanion).not.toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ zoneId: "z" }));
  });

  it("spreads minions apart in the comfort ring and only makes calm idle steps", () => {
    const { runtime, entities, combat } = harness();
    runtime.growTreant("p1", "duskroot", 3, 0);
    runtime.growTreant("p1", "mendbark", 3, 70_000);
    let now = 70_000;
    for (let tick = 0; tick < 80; tick += 1) { now += 100; runtime.update("p1", now); }
    const treants = [...entities.values()].filter((entity) => String(entity.entityId).startsWith("minion:"));
    const [a, b] = treants as Array<{ lat: number; lon: number }>;
    const apartM = Math.hypot((a!.lat - b!.lat) * 111_000, (a!.lon - b!.lon) * 111_000);
    expect(apartM).toBeGreaterThan(10);
    combat.relocateCompanion.mockClear();
    for (let tick = 0; tick < 300; tick += 1) { now += 100; runtime.update("p1", now); }
    // Only calm idle repositions: short steps that stay inside the comfort ring.
    for (const [, position] of combat.relocateCompanion.mock.calls as unknown as Array<[string, { lat: number; lon: number }]>) {
      const fromOwnerM = Math.hypot(position.lat * 111_000, position.lon * 111_000);
      expect(fromOwnerM).toBeLessThanOrEqual(100);
    }
  });

  it("never knocks back bosses or dungeon encounter mobs", () => {
    expect(isDisplaceable({ regionCode: "r" })).toBe(true);
    expect(isDisplaceable({ regionCode: "r", boss: true })).toBe(false);
    expect(isDisplaceable({ regionCode: "interior:dungeon:crypt:player:p1" })).toBe(false);
  });

  it("raises at most one Grave Echo and expires minions on time", () => {
    const { runtime } = harness();
    expect(runtime.recordBonewroughtDeath("p1", 1, 0)).toBe(true);
    expect(runtime.recordBonewroughtDeath("p1", 1, 0)).toBe(false);
    runtime.update("p1", 36 * 60 * 1_000);
    expect(runtime.count("p1")).toBe(0);
  });
});

function harness() {
  const entities = new Map<string, Record<string, unknown>>([["p1", {
    entityId: "p1", kind: "player", lifeState: "alive", lat: 0, lon: 0, regionCode: "r", zoneId: "z",
    targetEntityId: null, name: "Ash", maxHealth: 100, currentHealth: 100
  }]]);
  const combat = {
    entity: vi.fn((id: string) => entities.get(id) ?? null),
    spawnMob: vi.fn((spawn: { entityId: string; position: { lat: number; lon: number }; companion: { maxHealth: number } }) => {
      entities.set(spawn.entityId, { entityId: spawn.entityId, kind: "mob", lifeState: "alive", ...spawn.position,
        regionCode: "r", zoneId: "z", maxHealth: spawn.companion.maxHealth, currentHealth: spawn.companion.maxHealth });
    }),
    despawnMob: vi.fn((id: string) => entities.delete(id)),
    rescaleCompanionHealth: vi.fn(() => true),
    attackDamageOf: vi.fn(() => 5),
    relocateCompanion: vi.fn((id: string, position: { lat: number; lon: number }, scope?: { regionCode: string; zoneId: string }) => {
      Object.assign(entities.get(id)!, position, scope ? { regionCode: scope.regionCode, zoneId: scope.zoneId } : {});
      return true;
    }),
    applyScriptedDamage: vi.fn(() => 5),
    applyPetEffect: vi.fn(() => true),
    playerMovementMultiplier: vi.fn(() => 1),
    healEntity: vi.fn(() => 0),
    nearbyEntityIds: vi.fn((): string[] => []),
    petTacticsShare: vi.fn(() => 0),
    generalSkillRank: vi.fn(() => 0)
  };
  const runtime = new MinionRuntime(combat as unknown as CombatEngine, { playerBaseSpeedMps: 100, random: () => 0 });
  return { runtime, combat, entities };
}
