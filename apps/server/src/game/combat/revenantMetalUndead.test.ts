import { describe, expect, it, vi } from "vitest";

import {
  BASIC_ATTACK_INTERVAL_MS,
  PVE_TURN_STEP_MS,
  PVP_MAX_HEALTH_PENALTY,
  addMaxHealthPenalty,
  applyMaxHealthDebuff,
  effectiveMaxHealthPenalty,
  emptyEquipmentSlots,
  metalEquipmentEnhancement,
  mobV4Profile,
  resolveDamageMatrixV4,
  resolveEquipmentCombatStats,
  resolvePlayerMaxHealth,
  serializeEquipmentEnhancement,
  distanceMeters,
  type EquipmentMetal,
  type LatLon
} from "@ash-atlas/shared";

import {
  CombatEngine,
  type RevenantMetalHandler,
  type PlayerEquipmentCombatState
} from "./combatEngine.js";
import { REVENANT_METAL_FORMATION, formationSlotPosition } from "./revenantMetalFormation.js";
import {
  REVENANT_METAL_BALANCE,
  RevenantMetalUndeadRuntime,
  planSkeletonRaise,
  skeletonMobLevel,
  type RevenantMetalLichStore
} from "./revenantMetalUndead.js";

/** One basic attack interval and its player half, in 20 Hz ticks. */
const BEAT = BASIC_ATTACK_INTERVAL_MS * 20 / 1_000;
const HALF = PVE_TURN_STEP_MS * 20 / 1_000;

const ORIGIN = { lat: 35.0844, lon: -106.6504 };
const TICKS_PER_SECOND = 20;
const RECOVERY_STEP = PVP_MAX_HEALTH_PENALTY.recoveryIntervalMs;

describe("Revenant Metal skeleton raise plan", () => {
  it("spawns level 1 below the cap of 4", () => {
    expect(planSkeletonRaise([])).toEqual({ kind: "spawn", level: 1 });
    expect(planSkeletonRaise(skeletonRecords([3, 1, 5]))).toEqual({ kind: "spawn", level: 1 });
  });

  it("at 4, upgrades the lowest-level skeleton; ties go to the least time left", () => {
    const records = skeletonRecords([3, 2, 4, 2]);
    // Two level-2 skeletons: s1 expires at 2_000, s3 at 4_000.
    expect(planSkeletonRaise(records)).toEqual({ kind: "upgrade", entityId: "s1", level: 3 });
  });

  it("never passes level 5; with all four at 5 it refreshes the one with the least time left", () => {
    const records = skeletonRecords([5, 5, 5, 5]).map((record, index) => ({ ...record, expiresAt: 10_000 - index }));
    expect(planSkeletonRaise(records)).toEqual({ kind: "upgrade", entityId: "s3", level: 5 });
  });

  it("fights as mob level min(6 x N, owner effective level)", () => {
    expect(skeletonMobLevel(1, 20)).toBe(6);
    expect(skeletonMobLevel(3, 12)).toBe(12);
    expect(skeletonMobLevel(5, 25)).toBe(25);
    expect(skeletonMobLevel(2, 0)).toBe(0);
  });
});

describe("Revenant Metal runtime", () => {
  it("raises up to 4 skeletons at the victim, then upgrades the lowest and resets its lifetime", () => {
    let now = 1_000_000;
    const { engine, runtime } = createRuntime(() => now);
    addPlayer(engine, "owner", ORIGIN, 25);

    for (let kill = 0; kill < 4; kill += 1) {
      runtime.onRevenantWeaponKillingBlow({ ownerPlayerId: "owner", position: east(30), regionCode: "NM", zoneId: "world:NM" });
      runtime.updateAll(now);
      now += 1_000;
    }
    const raised = runtime.skeletons("owner");
    expect(raised).toHaveLength(4);
    expect(raised.every((skeleton) => skeleton.level === 1)).toBe(true);
    const first = engine.entity(raised[0]!.entityId)!;
    expect(first).toMatchObject({ archetypeKey: "risen_skeleton", level: 6, undead: { ownerPlayerId: "owner", kind: "skeleton", level: 1 } });
    expect(first.undead!.expiresAt).toBe(1_000_000 + REVENANT_METAL_BALANCE.skeletonLifetimeMs);

    runtime.onRevenantWeaponKillingBlow({ ownerPlayerId: "owner", position: east(30), regionCode: "NM", zoneId: "world:NM" });
    runtime.updateAll(now);
    const afterUpgrade = runtime.skeletons("owner");
    expect(afterUpgrade).toHaveLength(4);
    // The oldest level-1 skeleton (least time left) became level 2 with a fresh lifetime.
    expect(afterUpgrade[0]).toMatchObject({ entityId: raised[0]!.entityId, level: 2, expiresAt: now + REVENANT_METAL_BALANCE.skeletonLifetimeMs });
    expect(engine.entity(raised[0]!.entityId)).toMatchObject({ level: 12, undead: { level: 2 } });
  });

  it("expires skeletons after their lifetime and dismisses them when the owner leaves the overworld", () => {
    let now = 5_000_000;
    let present = true;
    const { engine, runtime } = createRuntime(() => now, () => present);
    addPlayer(engine, "owner", ORIGIN, 10);
    runtime.onRevenantWeaponKillingBlow({ ownerPlayerId: "owner", position: east(20), regionCode: "NM", zoneId: "world:NM" });
    runtime.updateAll(now);
    now += 500;
    runtime.onRevenantWeaponKillingBlow({ ownerPlayerId: "owner", position: east(20), regionCode: "NM", zoneId: "world:NM" });
    runtime.updateAll(now);
    const [older, newer] = runtime.skeletons("owner");

    now = older!.expiresAt;
    runtime.updateAll(now);
    expect(engine.entity(older!.entityId)).toBeNull();
    expect(runtime.skeletons("owner").map((skeleton) => skeleton.entityId)).toEqual([newer!.entityId]);

    present = false;
    runtime.updateAll(now);
    expect(engine.entity(newer!.entityId)).toBeNull();
    expect(runtime.skeletons("owner")).toEqual([]);
  });

  it("replaces the Lich on a new death and despawns (not destroys) it outside the overworld", async () => {
    let now = 9_000_000;
    let present = true;
    const store = memoryStore();
    const { engine, runtime } = createRuntime(() => now, () => present, store);
    addPlayer(engine, "owner", ORIGIN, 10);
    const snapshot = lichSnapshot();

    runtime.onRevenantArmorDeath({
      ownerPlayerId: "owner", deathOperationKey: "player-death:a", position: east(10),
      regionCode: "NM", zoneId: "world:NM", killerEntityId: null, snapshot
    });
    runtime.updateAll(now);
    const first = runtime.lich("owner")!;
    expect(engine.entity(first.entityId!)).toMatchObject({
      name: "owner's Lich", maxHealth: 140, currentHealth: 140, undead: { kind: "lich", ownerPlayerId: "owner" }
    });
    expect(first.record.expiresAt).toBe(now + REVENANT_METAL_BALANCE.lichLifetimeMs);

    runtime.onRevenantArmorDeath({
      ownerPlayerId: "owner", deathOperationKey: "player-death:b", position: east(40),
      regionCode: "NM", zoneId: "world:NM", killerEntityId: null, snapshot
    });
    runtime.updateAll(now);
    const second = runtime.lich("owner")!;
    expect(engine.entity(first.entityId!)).toBeNull();
    expect(engine.entity(second.entityId!)).not.toBeNull();
    expect(store.replace).toHaveBeenCalledTimes(2);
    expect(store.rows.get("owner")?.deathOperationKey).toBe("player-death:b");

    // Damage it, leave the overworld: despawned with its HP kept, then restored beside the owner.
    internals(engine).entities.get(second.entityId!)!.currentHealth = 90;
    present = false;
    runtime.updateAll(now);
    await Promise.resolve();
    expect(engine.entity(second.entityId!)).toBeNull();
    expect(runtime.lich("owner")).toMatchObject({ entityId: null, record: { currentHealth: 90 } });
    expect(store.rows.get("owner")?.currentHealth).toBe(90);
    present = true;
    now += 1_000;
    runtime.updateAll(now);
    const restored = runtime.lich("owner")!;
    expect(engine.entity(restored.entityId!)).toMatchObject({ currentHealth: 90, maxHealth: 140 });

    // 20 hours keep running while despawned; expiry destroys it.
    now = restored.record.expiresAt;
    runtime.updateAll(now);
    await Promise.resolve();
    expect(runtime.lich("owner")).toBeNull();
    expect(store.rows.has("owner")).toBe(false);
  });

  it("never heals the undead", () => {
    const { engine, runtime } = createRuntime(() => 1);
    addPlayer(engine, "owner", ORIGIN, 10);
    runtime.onRevenantWeaponKillingBlow({ ownerPlayerId: "owner", position: east(10), regionCode: "NM", zoneId: "world:NM" });
    runtime.updateAll(1);
    const id = runtime.skeletons("owner")[0]!.entityId;
    const skeleton = internals(engine).entities.get(id)!;
    skeleton.currentHealth = 5;
    expect(engine.healEntity(id, 50)).toBe(0);
    expect(engine.healMob(id, 50)).toBe(0);
    expect(skeleton.currentHealth).toBe(5);
  });
});

describe("Revenant Metal engine triggers", () => {
  it("raises a skeleton only for a direct attack from a Revenant weapon", () => {
    const handler = spyHandler();
    const engine = createEngine({ random: () => 0.99 });
    engine.setRevenantMetalHandler(handler);
    addPlayer(engine, "owner", ORIGIN, 10);
    engine.syncPlayerEquipmentCombatState("owner", equipmentState("revenant", "weapon"));
    const mob = spawnDummy(engine, east(10));
    internals(engine).entities.get(mob.entityId)!.currentHealth = 1;

    engine.startAttack(authority("owner", mob.entityId, "dead-kill"));
    engine.tick();

    expect(engine.entity(mob.entityId)).toBeNull();
    expect(handler.onRevenantWeaponKillingBlow).toHaveBeenCalledWith(expect.objectContaining({ ownerPlayerId: "owner" }));
  });

  it("ignores kills from damage-over-time ticks, from undead, and from non-Revenant weapons", () => {
    const handler = spyHandler();
    const engine = createEngine({ random: () => 0 });
    engine.setRevenantMetalHandler(handler);
    addPlayer(engine, "owner", ORIGIN, 10);
    engine.syncPlayerEquipmentCombatState("owner", equipmentState("revenant", "weapon"));
    const internal = internals(engine);

    // Poison tick kill.
    const poisoned = spawnDummy(engine, east(10));
    internal.entities.get(poisoned.entityId)!.currentHealth = 1;
    internal.applyMetalEffect(internal.entities.get("owner")!, internal.entities.get(poisoned.entityId)!, "poison", "weapon");
    for (let tick = 0; tick < 4 * TICKS_PER_SECOND; tick += 1) engine.tick();
    expect(engine.entity(poisoned.entityId)).toBeNull();

    // Skeleton kill: credited to the owner, but no new skeleton.
    const skeleton = engine.spawnMob({
      entityId: "undead-skeleton:test", archetype: "skeleton", position: east(20), regionCode: "NM", zoneId: "world:NM",
      undead: { ownerPlayerId: "owner", kind: "skeleton", level: 1, expiresAt: Date.now() + REVENANT_METAL_BALANCE.skeletonLifetimeMs }
    });
    const victim = spawnDummy(engine, east(21));
    internal.entities.get(victim.entityId)!.currentHealth = 1;
    expect(engine.applyUndeadAttack(skeleton.entityId, victim.entityId)).toBe(1);
    expect(engine.entity(victim.entityId)).toBeNull();

    // Plain weapon kill.
    engine.syncPlayerEquipmentCombatState("owner", equipmentState("fire", "weapon"));
    const plain = spawnDummy(engine, east(5));
    internal.entities.get(plain.entityId)!.currentHealth = 1;
    engine.startAttack(authority("owner", plain.entityId, "plain-kill"));
    engine.tick();
    expect(engine.entity(plain.entityId)).toBeNull();

    expect(handler.onRevenantWeaponKillingBlow).not.toHaveBeenCalled();
  });

  it("reports a skeleton's PvP kill as the owner's, with the victim's Revenant armor and a Lich snapshot", () => {
    const handler = spyHandler();
    const onPlayerDefeated = vi.fn();
    const engine = createEngine({ random: () => 0.99, onPlayerDefeated });
    engine.setRevenantMetalHandler(handler);
    addPlayer(engine, "owner", ORIGIN, 10);
    addPlayer(engine, "victim", east(10), 10);
    engine.syncPlayerEquipmentCombatState("victim", equipmentState("revenant", "armor"));
    const skeleton = engine.spawnMob({
      entityId: "undead-skeleton:pvp", archetype: "skeleton", position: east(11), regionCode: "NM", zoneId: "world:NM",
      undead: { ownerPlayerId: "owner", kind: "skeleton", level: 1, expiresAt: Date.now() + REVENANT_METAL_BALANCE.skeletonLifetimeMs }
    });
    internals(engine).entities.get("victim")!.currentHealth = 1;

    expect(engine.applyUndeadAttack(skeleton.entityId, "victim")).toBe(1);

    // The owner is the killer for PvP losses, but a skeleton's blow pays no death gold.
    expect(onPlayerDefeated).toHaveBeenCalledWith("victim", expect.any(String), "owner", { revenantArmor: true, goldEligible: false });
    expect(handler.onRevenantArmorDeath).toHaveBeenCalledWith(expect.objectContaining({
      ownerPlayerId: "victim",
      killerEntityId: "owner",
      snapshot: expect.objectContaining({ maxHealth: 100, name: "victim's Lich" })
    }));
  });

  it("lets a monster turn on the undead that hit it and kill it, with nothing owner-side", () => {
    const handler = spyHandler();
    const onPlayerDefeated = vi.fn();
    const engine = createEngine({ random: () => 0.99, onPlayerDefeated });
    engine.setRevenantMetalHandler(handler);
    addPlayer(engine, "owner", ORIGIN, 10);
    const skeleton = engine.spawnMob({
      entityId: "undead-skeleton:tank", archetype: "skeleton", position: east(30), regionCode: "NM", zoneId: "world:NM",
      undead: { ownerPlayerId: "owner", kind: "skeleton", level: 1, expiresAt: Date.now() + REVENANT_METAL_BALANCE.skeletonLifetimeMs }
    });
    const wolf = engine.spawnMob({ archetype: "wolf", position: east(31), regionCode: "NM", zoneId: "world:NM" });

    expect(engine.applyUndeadAttack(skeleton.entityId, wolf.entityId)).toBeGreaterThan(0);
    expect(engine.entity(wolf.entityId)?.targetEntityId).toBe(skeleton.entityId);

    const before = engine.entity(skeleton.entityId)!.currentHealth;
    for (let tick = 0; tick < 4 * TICKS_PER_SECOND; tick += 1) engine.tick();
    expect(engine.entity(skeleton.entityId)!.currentHealth).toBeLessThan(before);

    internals(engine).entities.get(skeleton.entityId)!.currentHealth = 1;
    for (let tick = 0; tick < 4 * TICKS_PER_SECOND && engine.entity(skeleton.entityId); tick += 1) engine.tick();
    expect(engine.entity(skeleton.entityId)).toBeNull();
    expect(engine.entity(wolf.entityId)?.targetEntityId).toBeNull();
    expect(engine.entity("owner")).toMatchObject({ lifeState: "alive", currentHealth: 100 });
    expect(onPlayerDefeated).not.toHaveBeenCalled();
    expect(handler.onRevenantWeaponKillingBlow).not.toHaveBeenCalled();
    expect(handler.onRevenantArmorDeath).not.toHaveBeenCalled();
  });

  it("lands undead-versus-monster hits on matrix v4 when DAMAGE_MATRIX_V4_ENABLED is on", () => {
    const engine = createEngine({ random: () => 0.99, damageMatrixV4Enabled: () => true });
    engine.setRevenantMetalHandler(spyHandler());
    addPlayer(engine, "owner", ORIGIN, 10);
    const skeleton = engine.spawnMob({
      entityId: "undead-skeleton:v4", archetype: "skeleton", position: east(30), regionCode: "NM", zoneId: "world:NM",
      undead: { ownerPlayerId: "owner", kind: "skeleton", level: 1, expiresAt: Date.now() + REVENANT_METAL_BALANCE.skeletonLifetimeMs }
    });
    const wolf = engine.spawnMob({ archetype: "wolf", position: east(31), regionCode: "NM", zoneId: "world:NM" });
    // Skeleton (its tier base, slash) into the Wolf's fur (leather 1.15), skeleton level against the Wolf's.
    expect(engine.applyUndeadAttack(skeleton.entityId, wolf.entityId)).toBe(resolveDamageMatrixV4({
      damageType: "slash", baseDamage: mobV4Profile("skeleton").baseDamage, armourType: "leather",
      attackerLevel: engine.entity(skeleton.entityId)!.level, defenderLevel: engine.entity(wolf.entityId)!.level
    }).finalDamage);
  });

  describe("one combat, many attackers", () => {
    type Sessions = { pveSessions: Map<string, { enemyIds: Set<string>; phase: string }> };
    const sessions = (engine: CombatEngine) => (engine as unknown as Sessions).pveSessions;
    const startFight = () => {
      const engine = createEngine({ random: () => 0.99 });
      addPlayer(engine, "owner", ORIGIN, 10);
      const skeleton = engine.spawnMob({
        entityId: "undead-skeleton:team", archetype: "skeleton", position: east(3), regionCode: "NM", zoneId: "world:NM",
        undead: { ownerPlayerId: "owner", kind: "skeleton", level: 1, expiresAt: Date.now() + REVENANT_METAL_BALANCE.skeletonLifetimeMs }
      });
      const wolf = engine.spawnMob({ archetype: "wolf", position: east(3), regionCode: "NM", zoneId: "world:NM" });
      internals(engine).entities.get(wolf.entityId)!.currentHealth = 100_000;
      const ownerEntity = internals(engine).entities.get("owner")! as unknown as { currentHealth: number; maxHealth: number };
      ownerEntity.currentHealth = ownerEntity.maxHealth = 100_000;
      engine.startAttack({
        attackerId: "owner", targetEntityId: wolf.entityId, requestId: "go",
        accountId: "account-owner", connectionId: "connection-owner"
      });
      return { engine, skeleton, wolf };
    };

    it("keeps the owner auto-attacking and the mob targeting them while the skeleton also hits", () => {
      const { engine, skeleton, wolf } = startFight();
      const health = () => internals(engine).entities.get(wolf.entityId)!.currentHealth;
      let skeletonHits = 0;
      let ownerOnlyDamage = 0;
      let skeletonDamage = 0;
      for (let tick = 0; tick < 12 * BEAT; tick += 1) {
        engine.tick();
        if (tick % BEAT === 0 && engine.undeadInPlayerPhase("owner")) {
          const before = health();
          if (engine.applyUndeadAttack(skeleton.entityId, wolf.entityId) > 0) {
            skeletonHits += 1;
            skeletonDamage += before - health();
          }
        }
        if (tick < 2) continue;
        expect(sessions(engine).get("owner")?.enemyIds.has(wolf.entityId), `tick ${tick}`).toBe(true);
        expect(engine.entity(wolf.entityId)?.targetEntityId).toBe("owner");
      }
      ownerOnlyDamage = 100_000 - health() - skeletonDamage;
      expect(skeletonHits).toBeGreaterThan(3);
      expect(skeletonDamage).toBeGreaterThan(0);
      expect(ownerOnlyDamage).toBeGreaterThan(0);
      expect(engine.entity("owner")!.currentHealth).toBeLessThan(100_000);
    });

    it("turns the mob on the skeleton once the owner leaves the fight or dies", () => {
      const { engine, skeleton, wolf } = startFight();
      for (let tick = 0; tick < 2 * BEAT; tick += 1) engine.tick();
      sessions(engine).delete("owner");
      const mob = engine.entity(wolf.entityId)!;
      expect(mob.targetEntityId).toBe("owner");
      internals(engine).entities.get("owner")!.currentHealth = 0;
      (engine as unknown as { entities: Map<string, { lifeState: string }> }).entities.get("owner")!.lifeState = "defeated";
      engine.applyUndeadAttack(skeleton.entityId, wolf.entityId);
      expect(engine.entity(wolf.entityId)?.targetEntityId).toBe(skeleton.entityId);
    });

    it("keeps hits off the mob's enemy-action tick", () => {
      const { engine, wolf } = startFight();
      engine.beginDeltaFlush();
      const allowed: boolean[] = [];
      const enemyActionTicks: number[] = [];
      for (let tick = 0; tick < 4 * BEAT; tick += 1) {
        engine.tick();
        const mobHitOwner = engine.beginDeltaFlush().events.some((event) =>
          event.type === "DAMAGE" && event.sourceEntityId === wolf.entityId && event.targetEntityId === "owner"
        );
        if (mobHitOwner) enemyActionTicks.push(tick);
        allowed.push(engine.undeadInPlayerPhase("owner"));
      }
      // The gate opens for exactly the player half of every beat and never on an enemy action.
      expect(enemyActionTicks.length).toBeGreaterThanOrEqual(3);
      for (const tick of enemyActionTicks) expect(allowed[tick], `enemy action tick ${tick}`).toBe(false);
      for (let start = BEAT; start + BEAT <= allowed.length; start += BEAT) {
        expect(allowed.slice(start, start + BEAT).filter(Boolean)).toHaveLength(HALF);
      }
    });
  });

  it("keeps undead under the owner's PvP gates (trust shield, arrival protection)", () => {
    const blocked = new Set<string>();
    const engine = createEngine({ isPvpBlocked: (attacker, target) => blocked.has(`${attacker}>${target}`) });
    addPlayer(engine, "owner", ORIGIN, 10);
    addPlayer(engine, "enemy", east(10), 10);
    const skeleton = engine.spawnMob({
      entityId: "undead-skeleton:gate", archetype: "skeleton", position: east(11), regionCode: "NM", zoneId: "world:NM",
      undead: { ownerPlayerId: "owner", kind: "skeleton", level: 1, expiresAt: Date.now() + REVENANT_METAL_BALANCE.skeletonLifetimeMs }
    });
    expect(engine.canUndeadAttack(skeleton.entityId, "enemy")).toBe(true);
    expect(engine.canUndeadAttack(skeleton.entityId, "owner")).toBe(false);
    blocked.add("owner>enemy");
    expect(engine.canUndeadAttack(skeleton.entityId, "enemy")).toBe(false);
    expect(engine.applyUndeadAttack(skeleton.entityId, "enemy")).toBe(0);
    blocked.clear();
    engine.grantFlagArrivalProtection("enemy", 1);
    expect(engine.canUndeadAttack(skeleton.entityId, "enemy")).toBe(false);
  });
});

describe("PvP max-HP penalty", () => {
  it("costs 6, or 4 with Revenant armor, recovering 1 per full 75 minutes", () => {
    expect(addMaxHealthPenalty(null, PVP_MAX_HEALTH_PENALTY.loss, 50, 0)).toMatchObject({ penalty: 6, appliedLoss: 6, recoveryAnchorMs: 0 });
    const afterTwo = addMaxHealthPenalty({ penalty: 6, recoveryAnchorMs: 0 }, PVP_MAX_HEALTH_PENALTY.revenantArmorLoss, 50, 2.5 * RECOVERY_STEP);
    // Two steps recovered (6 -> 4), +4; the half step of progress is kept.
    expect(afterTwo).toMatchObject({ penaltyBefore: 4, penalty: 8, recoveryAnchorMs: 2 * RECOVERY_STEP, appliedLoss: 4 });
    expect(effectiveMaxHealthPenalty(8, 2 * RECOVERY_STEP, 3 * RECOVERY_STEP - 1)).toBe(8);
    expect(effectiveMaxHealthPenalty(8, 2 * RECOVERY_STEP, 3 * RECOVERY_STEP)).toBe(7);
    expect(effectiveMaxHealthPenalty(8, 2 * RECOVERY_STEP, 20 * RECOVERY_STEP)).toBe(0);
    // A fully recovered penalty restarts its clock at the new loss.
    expect(addMaxHealthPenalty({ penalty: 2, recoveryAnchorMs: 0 }, 6, 50, 10 * RECOVERY_STEP)).toMatchObject({
      penaltyBefore: 0, penalty: 6, recoveryAnchorMs: 10 * RECOVERY_STEP
    });
  });

  it("never drops max HP below 50% of the unpenalized value", () => {
    expect(applyMaxHealthDebuff(100, 5)).toBe(95);
    expect(applyMaxHealthDebuff(100, 80)).toBe(50);
    expect(applyMaxHealthDebuff(131, 500)).toBe(66);
    expect(resolvePlayerMaxHealth({ exceptionalModifiers: [{ source: "debuff", sourceId: "pvp", flatBonus: -7 }] })).toBe(93);
    expect(resolvePlayerMaxHealth({ exceptionalModifiers: [{ source: "debuff", sourceId: "pvp", flatBonus: -90 }] })).toBe(50);
    expect(() => resolvePlayerMaxHealth({ exceptionalModifiers: [{ source: "debuff", sourceId: "pvp", flatBonus: 3 }] })).toThrow();
    expect(addMaxHealthPenalty({ penalty: 48, recoveryAnchorMs: 0 }, 5, 50, 0)).toMatchObject({ penalty: 50, appliedLoss: 2 });
  });

  it("applies in the engine on top of stat refreshes and recovers lazily", () => {
    let now = 0;
    const engine = createEngine({ now: () => now });
    addPlayer(engine, "player", ORIGIN, 10);
    engine.setPlayerMaxHealthPenalty("player", { penalty: 5, recoveryAnchorMs: 0 });
    expect(engine.entity("player")).toMatchObject({ maxHealth: 95, currentHealth: 95, maxHealthPenalty: 5 });
    engine.updatePlayerPveStats("player", { level: 10, maxHealth: 120, attackPower: 10, defense: 0 }, { preserveCurrentHealth: true });
    expect(engine.entity("player")).toMatchObject({ maxHealth: 115, maxHealthPenalty: 5 });
    expect(engine.unpenalizedMaxHealth("player")).toBe(120);

    now = RECOVERY_STEP;
    for (let tick = 0; tick < TICKS_PER_SECOND; tick += 1) engine.tick();
    // Recovered max HP is room to heal, not a heal.
    expect(engine.entity("player")).toMatchObject({ maxHealth: 116, currentHealth: 95, maxHealthPenalty: 4 });
    now = 10 * RECOVERY_STEP;
    for (let tick = 0; tick < TICKS_PER_SECOND; tick += 1) engine.tick();
    expect(engine.entity("player")?.maxHealth).toBe(120);
    expect(engine.entity("player")?.maxHealthPenalty).toBeUndefined();
  });
});

function skeletonRecords(levels: number[]) {
  return levels.map((level, index) => ({ entityId: `s${index}`, level, expiresAt: (index + 1) * 1_000 }));
}

function spyHandler() {
  return {
    onRevenantWeaponKillingBlow: vi.fn(),
    onRevenantArmorDeath: vi.fn()
  } satisfies RevenantMetalHandler;
}

function memoryStore() {
  const rows = new Map<string, { deathOperationKey: string; currentHealth: number }>();
  const store = {
    rows,
    load: vi.fn(async () => null),
    replace: vi.fn(async (lich: Parameters<RevenantMetalLichStore["replace"]>[0]) => {
      rows.set(lich.ownerPlayerId, { deathOperationKey: lich.deathOperationKey, currentHealth: lich.currentHealth });
    }),
    updateHealth: vi.fn(async (owner: string, key: string, health: number) => {
      const row = rows.get(owner);
      if (row?.deathOperationKey === key) row.currentHealth = health;
    }),
    remove: vi.fn(async (owner: string, key: string) => {
      if (rows.get(owner)?.deathOperationKey === key) rows.delete(owner);
    })
  };
  return store;
}

function lichSnapshot() {
  return {
    name: "owner's Lich", level: 10, maxHealth: 140, attack: 18, defense: 4,
    weaponProfile: "sword", weaponLevel: 6, bodyProfile: "breastplate", bodyLevel: 5,
    shieldProfile: null, shieldLevel: 0
  } as const;
}

function createRuntime(now: () => number, present: () => boolean = () => true, store?: RevenantMetalLichStore) {
  const engine = createEngine({ now });
  let id = 0;
  const runtime = new RevenantMetalUndeadRuntime(engine, {
    playerBaseSpeedMps: 40,
    isOverworldPresent: present,
    ...(store ? { store } : {}),
    random: () => 0.5,
    idFactory: () => String(++id)
  });
  engine.setRevenantMetalHandler(runtime);
  return { engine, runtime };
}

function createEngine(overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  return new CombatEngine({
    tickRateHz: TICKS_PER_SECOND,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    ...overrides
  });
}

function addPlayer(engine: CombatEngine, playerId: string, position: LatLon, level: number): void {
  engine.connectPlayer({
    playerId,
    name: playerId,
    regionCode: "NM",
    zoneId: "world:NM",
    position,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth: 100, baseAttackDamage: 10, defense: 0, level }
  });
}

function spawnDummy(engine: CombatEngine, position: LatLon) {
  return engine.spawnMob({ archetype: "training_dummy", position, regionCode: "NM", zoneId: "world:NM" });
}

function equipmentState(metal: EquipmentMetal, source: "weapon" | "armor"): PlayerEquipmentCombatState {
  const stats = resolveEquipmentCombatStats({
    context: "pve",
    characterLevel: 0,
    classId: "warrior",
    classRank: 0,
    loadout: { active: emptyEquipmentSlots(null), readiedWeaponSlot: "melee" }
  });
  const enchantment = serializeEquipmentEnhancement(metalEquipmentEnhancement("ruby", metal));
  return {
    activeKitIndex: 1,
    inventoryRevision: 1,
    activeRevision: 1,
    stats,
    weaponCategory: "sword",
    chestArmorCategory: source === "armor" ? "heavy" : null,
    heavyArmorPieces: source === "armor" ? 1 : 0,
    hasShield: false,
    activeWeaponInstanceId: "weapon",
    activeWeaponEnchantmentIdentity: source === "weapon" ? enchantment : null,
    armorEnchantmentIdentities: { head: null, chest: source === "armor" ? enchantment : null, gloves: null, boots: null },
    revenantArmor: source === "armor" && metal === "revenant",
    reactiveArmorEnhancements: [],
    weaponSlots: {
      melee: { instanceId: "weapon", category: "sword", enchantmentIdentity: source === "weapon" ? enchantment : null },
      secondary: { instanceId: null, category: null, enchantmentIdentity: null }
    },
    activeWeaponSlot: "melee",
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  };
}

type InternalCombatant = { entityId: string; currentHealth: number };
type Internals = {
  entities: Map<string, InternalCombatant>;
  applyMetalEffect(owner: InternalCombatant, target: InternalCombatant, effectId: string, source: "weapon" | "armor"): void;
};

function internals(engine: CombatEngine): Internals {
  return engine as unknown as Internals;
}

function authority(attackerId: string, targetEntityId: string, requestId: string) {
  return { attackerId, targetEntityId, requestId, accountId: `account-${attackerId}`, connectionId: `connection-${attackerId}` };
}

function east(distanceM: number): LatLon {
  return { lat: ORIGIN.lat, lon: ORIGIN.lon + distanceM / 91_000 };
}

describe("Revenant Metal formation in the runtime", () => {
  it("settles skeletons and the Lich into distinct slots and re-packs when one dies", () => {
    let now = 5_000_000;
    const { engine, runtime } = createRuntime(() => now);
    addPlayer(engine, "owner", ORIGIN, 25);
    runtime.onRevenantArmorDeath({
      ownerPlayerId: "owner", deathOperationKey: "player-death:f", position: ORIGIN,
      regionCode: "NM", zoneId: "world:NM", killerEntityId: null, snapshot: lichSnapshot()
    });
    for (let kill = 0; kill < 3; kill += 1) {
      runtime.onRevenantWeaponKillingBlow({ ownerPlayerId: "owner", position: ORIGIN, regionCode: "NM", zoneId: "world:NM" });
    }
    const settle = () => { for (let step = 0; step < 900; step += 1) { now += 100; runtime.updateAll(now); } };
    settle();
    const ids = () => [runtime.lich("owner")!.entityId!, ...runtime.skeletons("owner").map((s) => s.entityId)];
    const positions = () => ids().map((id) => engine.entity(id)!);
    const pairwiseMin = () => {
      const list = positions();
      let min = Infinity;
      for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) min = Math.min(min, distanceMeters(list[a]!, list[b]!));
      return min;
    };
    expect(ids()).toHaveLength(4);
    // They roam loosely (pet logic), so the slot spacing is only approximate while they amble.
    expect(pairwiseMin()).toBeGreaterThanOrEqual(REVENANT_METAL_FORMATION.attackSpacingM);
    const ownerPos = engine.entity("owner")!;
    const [lich, ...skeletons] = positions();
    for (const undead of positions()) {
      expect(distanceMeters(undead, ownerPos)).toBeGreaterThanOrEqual(60);
      expect(distanceMeters(undead, ownerPos)).toBeLessThanOrEqual(260);
    }
    expect(distanceMeters(lich!, ownerPos)).toBeLessThanOrEqual(130);
    void skeletons;

    // Kill the middle skeleton: the last one moves up into its slot.
    const [, first, middle, last] = ids();
    void first;
    internals(engine).entities.get(middle!)!.currentHealth = 0;
    engine.despawnMob(middle!);
    settle();
    expect(runtime.skeletons("owner").map((s) => s.entityId)).toHaveLength(2);
    expect(runtime.skeletons("owner").map((s) => s.entityId)).toContain(last);
    expect(pairwiseMin()).toBeGreaterThanOrEqual(REVENANT_METAL_FORMATION.attackSpacingM);
  });

  it("does not move an undead that stands near its slot, and never snaps onto the exact slot", () => {
    let now = 5_000_000;
    const { engine, runtime } = createRuntime(() => now);
    addPlayer(engine, "owner", ORIGIN, 25);
    const slot = formationSlotPosition(ORIGIN, 0, 0);
    runtime.onRevenantWeaponKillingBlow({ ownerPlayerId: "owner", position: { lat: slot.lat + 0.0001, lon: slot.lon }, regionCode: "NM", zoneId: "world:NM" });
    now += 100; runtime.updateAll(now);
    const id = runtime.skeletons("owner")[0]!.entityId;
    const before = { ...engine.entity(id)! };
    for (let step = 0; step < 100; step += 1) { now += 100; runtime.updateAll(now); }
    const after = engine.entity(id)!;
    expect(distanceMeters(before, after)).toBeLessThan(0.01);
    expect(distanceMeters(after, slot)).toBeGreaterThan(5);
  });
});
