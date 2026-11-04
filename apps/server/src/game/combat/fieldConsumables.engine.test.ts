import { destinationPoint, type LatLon } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { getTravelBlockReason } from "../travelEligibility.js";
import { CombatEngine } from "./combatEngine.js";

const origin = { lat: 35.0844, lon: -106.6504 };
type Internal = Map<string, {
  currentHealth: number; maxHealth: number; position: LatLon; aggressiveUntilMs: number;
  special?: { stunUntilTick: number };
  classRuntime?: { effects: Array<{ kind: string; endTick: number }> } | null;
}>;

function setup(extra: Record<string, unknown> = {}) {
  const engine = new CombatEngine({
    tickRateHz: 20, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true, ...extra
  });
  for (const id of ["p1", "p2"]) {
    engine.connectPlayer({
      playerId: id, name: id, regionCode: "NM", zoneId: "world:NM",
      position: id === "p1" ? origin : destinationPoint(origin, 4, 0),
      accountId: `account-${id}`, connectionId: `connection-${id}`,
      profile: { playerId: id, maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
    });
  }
  const spawn = (entityId: string, archetype: "wolf" | "slime_miniboss", distanceM: number) =>
    engine.spawnMob({ entityId, archetype, position: destinationPoint(origin, distanceM, 90), regionCode: "NM", zoneId: "world:NM" }).entityId;
  const internals = (engine as unknown as { entities: Internal }).entities;
  return { engine, internals, spawn };
}

function giveRanks(engine: CombatEngine, playerId: string, ranks: Record<string, number>): void {
  engine.updatePlayerSkillState(playerId, {
    fullClassRosterEnabled: false, ultimatesEnabled: false, fullBuildRespecAvailable: false, playerId, characterLevel: 25,
    pointState: { totalEarned: 25, totalSpent: 0, available: 25, revision: 1 },
    generalSkills: Object.entries(ranks).map(([skillId, rank]) => ({ skillId, rank, pointsSpent: 0 })),
    specializations: [], committedSpecializationId: null, activeSpecializationId: null, equippedClassTechniqueId: null,
    generalActiveLoadout: [null, null], ultimate: null, cooldownEndsAt: {}, worldKnowledge: [], serverTime: Date.now(), revision: 1
  } as never);
}

const effects = (internals: Internal, id: string) =>
  internals.get(id)!.classRuntime?.effects.map((effect) => effect.kind) ?? [];

describe("field consumables on the combat engine", () => {
  it("Net holds a monster: rooted and unable to attack", () => {
    const { engine, internals, spawn } = setup();
    const wolf = spawn("mob:wolf", "wolf", 6);
    expect(engine.checkFieldConsumable("p1", "field_net", wolf)).toBeNull();
    const outcome = engine.applyFieldConsumable("p1", "field_net", wolf);
    expect(outcome).toMatchObject({ hits: 1 });
    expect(effects(internals, wolf)).toContain("rooted");
    expect(internals.get(wolf)!.special!.stunUntilTick).toBeGreaterThan(0);
  });

  it("Net refuses bosses, players, missing targets and far targets", () => {
    const { engine, spawn } = setup();
    const boss = spawn("mob:boss", "slime_miniboss", 6);
    const far = spawn("mob:far", "wolf", 80);
    expect(engine.checkFieldConsumable("p1", "field_net", boss)?.code).toBe("FIELD_NET_TARGET_BOSS");
    expect(engine.checkFieldConsumable("p1", "field_net", "p2")?.code).toBe("FIELD_NET_TARGET_PLAYER");
    expect(engine.checkFieldConsumable("p1", "field_net", null)?.code).toBe("FIELD_NET_NO_TARGET");
    expect(engine.checkFieldConsumable("p1", "field_net", far)?.code).toBe("FIELD_NET_OUT_OF_RANGE");
  });

  it("Trap roots the first monster to walk in, not a boss, one per player", () => {
    const { engine, internals, spawn } = setup();
    const boss = spawn("mob:boss", "slime_miniboss", 1);
    const wolf = spawn("mob:wolf", "wolf", 30);
    expect(engine.applyFieldConsumable("p1", "field_trap", null)).toMatchObject({ itemId: "field_trap" });
    expect(engine.checkFieldConsumable("p1", "field_trap", null)?.code).toBe("FIELD_TRAP_ALREADY_SET");
    engine.beginTick();
    expect(effects(internals, boss)).not.toContain("rooted");
    expect(effects(internals, wolf)).not.toContain("rooted");
    internals.get(wolf)!.position = destinationPoint(origin, 1, 270);
    engine.relocateMob?.(wolf, internals.get(wolf)!.position);
    engine.beginTick();
    expect(effects(internals, wolf)).toContain("rooted");
    // The trap is spent, so another may be set.
    expect(engine.checkFieldConsumable("p1", "field_trap", null)).toBeNull();
  });

  it("Ember Bomb burns monsters in reach and spares those outside", () => {
    const { engine, internals, spawn } = setup();
    const near = spawn("mob:near", "wolf", 4);
    const outside = spawn("mob:outside", "wolf", 40);
    for (const id of [near, outside]) internals.get(id)!.currentHealth = internals.get(id)!.maxHealth = 1_000;
    const nearBefore = internals.get(near)!.currentHealth;
    const outcome = engine.applyFieldConsumable("p1", "ember_flask", null);
    expect(outcome).toMatchObject({ itemId: "ember_flask" });
    expect(internals.get(near)!.currentHealth).toBeLessThan(nearBefore);
    expect(internals.get(outside)!.currentHealth).toBe(internals.get(outside)!.maxHealth);
  });

  it("Anti-Venom blocks Venom and clears it", () => {
    const { engine, internals, spawn } = setup();
    const wolf = spawn("mob:wolf", "wolf", 6);
    const apply = (engine as unknown as { applyHarmfulStatus(a: unknown, b: unknown, s: string): boolean });
    const src = internals.get(wolf);
    const target = internals.get("p1");
    expect(apply.applyHarmfulStatus(src, target, "poison")).toBe(true);
    engine.stageFieldBuffs("p1", [{ buffId: "anti_venom", startedAt: Date.now(), endsAt: Date.now() + 60_000 }]);
    expect(effects(internals, "p1")).not.toContain("poison");
    expect(apply.applyHarmfulStatus(src, target, "poison")).toBe(false);
    // The Venom metal proc goes through its own path; immunity must hold there too.
    (engine as unknown as { applyMetalPoison(a: unknown, b: unknown): void }).applyMetalPoison(internals.get("p2"), target);
    expect(effects(internals, "p1")).not.toContain("poison");
    engine.stageFieldBuffs("p1", []);
    expect(apply.applyHarmfulStatus(src, target, "poison")).toBe(true);
  });

  it("Battle Draught costs health, and lifts the aggression travel lock while active", () => {
    const { engine, internals } = setup();
    internals.get("p1")!.aggressiveUntilMs = Date.now() + 10_000;
    const input = {
      playerId: "p1",
      gameState: { getPlayer: () => ({ online: true }), isWorldPresent: () => true, isMovementBlocked: () => false } as never,
      combat: engine
    };
    expect(getTravelBlockReason(input)?.code).toBe("TRAVEL_AGGRESSIVE");
    expect(engine.applyFieldConsumable("p1", "battle_draught", null)).toMatchObject({ itemId: "battle_draught" });
    expect(internals.get("p1")!.currentHealth).toBe(88);
    expect(engine.checkFieldConsumable("p1", "battle_draught", null)?.code).toBe("BATTLE_DRAUGHT_ACTIVE");
    expect(getTravelBlockReason(input)).toBeNull();
  });

  it("Battle Draught is +5 Attack and -3 Defense in the stat units gear uses", () => {
    const { engine, internals } = setup();
    const stats = engine as unknown as {
      warriorFlatAttackBonus(a: unknown, basic: boolean, t?: unknown): number;
      warriorFlatDefenseBonus(t: unknown): number;
    };
    const p1 = internals.get("p1");
    const attackBefore = stats.warriorFlatAttackBonus(p1, true);
    const defenseBefore = stats.warriorFlatDefenseBonus(p1);
    engine.applyFieldConsumable("p1", "battle_draught", null);
    expect(stats.warriorFlatAttackBonus(p1, true) - attackBefore).toBe(5);
    expect(stats.warriorFlatDefenseBonus(p1) - defenseBefore).toBe(-3);
  });

  it("Vigor Serum adds 120 max health and heals by it, then is removed on death", () => {
    const lost: string[] = [];
    const { engine, internals } = setup({ onVigorSerumLost: (id: string) => lost.push(id) });
    const p1 = internals.get("p1")!;
    p1.currentHealth = 60;
    const buff = { buffId: "vigor_serum" as const, startedAt: Date.now(), endsAt: Date.now() + 3_600_000 };
    engine.stageFieldBuffs("p1", [buff], { drank: true });
    expect(p1.maxHealth).toBe(220);
    expect(p1.currentHealth).toBe(180);
    expect(engine.unpenalizedMaxHealth("p1")).toBe(100);
    // Staging again (a replayed request or a refresh) changes nothing.
    engine.stageFieldBuffs("p1", [buff], { drank: true });
    expect(p1.maxHealth).toBe(220);
    expect(p1.currentHealth).toBe(180);
    // Defeat removes the bonus and the stored buff.
    (p1 as unknown as { lifeState: string }).lifeState = "dead";
    engine.beginTick();
    expect(p1.maxHealth).toBe(100);
    expect(lost).toEqual(["p1"]);
  });

  it("Vigor Serum ending clamps current health, and a login stage does not heal", () => {
    const { engine, internals } = setup();
    const p1 = internals.get("p1")!;
    engine.stageFieldBuffs("p1", [{ buffId: "vigor_serum", startedAt: Date.now(), endsAt: Date.now() + 3_600_000 }]);
    expect(p1.maxHealth).toBe(220);
    expect(p1.currentHealth).toBe(100);
    p1.currentHealth = 200;
    engine.stageFieldBuffs("p1", []);
    expect(p1.maxHealth).toBe(100);
    expect(p1.currentHealth).toBe(100);
  });

  it("Alchemy rank 3 Ember Bombs hit 22% harder and leave non-boss monsters Exposed; lower ranks do not", () => {
    const burn = (rank: number) => {
      const { engine, internals, spawn } = setup();
      const wolf = spawn("mob:wolf", "wolf", 4);
      const boss = spawn("mob:boss", "slime_miniboss", 4);
      for (const id of [wolf, boss]) internals.get(id)!.currentHealth = internals.get(id)!.maxHealth = 100_000;
      giveRanks(engine, "p1", { alchemy: rank });
      engine.applyFieldConsumable("p1", "ember_flask", null);
      const lost = (id: string) => 100_000 - internals.get(id)!.currentHealth;
      return { wolfLost: lost(wolf), bossLost: lost(boss), wolfEffects: effects(internals, wolf), bossEffects: effects(internals, boss) };
    };
    const base = burn(2);
    const alchemist = burn(3);
    expect(base.wolfEffects).not.toContain("quarry_exposure");
    expect(alchemist.wolfEffects).toContain("quarry_exposure");
    expect(alchemist.bossEffects).not.toContain("quarry_exposure");
    expect(alchemist.wolfLost / base.wolfLost).toBeCloseTo(1.22, 1);
    expect(alchemist.bossLost).toBeGreaterThan(base.bossLost);
  });

  it("Leatherworking gives +2 Defense from rank 1 and +2 Attack from rank 2 against leather-dropping monsters only", () => {
    const { engine, internals, spawn } = setup();
    const elk = internals.get(spawn("mob:elk", "elk" as never, 6))!;
    const wolf = internals.get(spawn("mob:slime", "slime_miniboss", 6))!;
    const player = internals.get("p1")!;
    const bonus = engine as unknown as {
      v3PveContextualAttackBonus(a: unknown, t: unknown): number;
      v3PveContextualDefenseBonus(t: unknown, a: unknown): number;
    };
    const at = (rank: number) => {
      giveRanks(engine, "p1", { leatherworking: rank });
      return {
        elkAttack: bonus.v3PveContextualAttackBonus(player, elk), elkDefense: bonus.v3PveContextualDefenseBonus(player, elk),
        wolfAttack: bonus.v3PveContextualAttackBonus(player, wolf), wolfDefense: bonus.v3PveContextualDefenseBonus(player, wolf)
      };
    };
    expect(at(0)).toEqual({ elkAttack: 0, elkDefense: 0, wolfAttack: 0, wolfDefense: 0 });
    expect(at(1)).toEqual({ elkAttack: 0, elkDefense: 2, wolfAttack: 0, wolfDefense: 0 });
    expect(at(2)).toEqual({ elkAttack: 2, elkDefense: 2, wolfAttack: 0, wolfDefense: 0 });
    expect(at(3)).toEqual({ elkAttack: 2, elkDefense: 2, wolfAttack: 0, wolfDefense: 0 });
  });
});
