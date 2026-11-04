import { describe, expect, it, vi } from "vitest";

import {
  ARCANE_BLAST_SHOT_PROFILE,
  destinationPoint,
  distanceMeters,
  emptyEquipmentSlots,
  requireEquipmentDefinition,
  resolveDamageMatrixV4,
  resolveEquipmentCombatStats,
  SHOT_DAMAGE_FACTOR,
  SHOT_RANGE_M,
  SHOT_RECOVERY_TICKS,
  SWING_BUFFER_EARLY_TICKS,
  SWING_DAMAGE_FACTORS,
  SWING_HITSTUN_TICKS,
  SWING_KNOCKBACK_M,
  SWING_MAX_TARGETS,
  SWING_RANGE_M,
  SWING_RECOVERY_TICKS,
  SWORD_GENERIC_ATTACK_PROFILE,
  type ActiveEquipmentLoadout,
  type EquipmentDefinitionId,
  type LatLon
} from "@ash-atlas/shared";
import {
  CombatEngine,
  type PlayerEquipmentCombatState,
  type SwingInput,
  type SwingResolution
} from "./combatEngine.js";

const origin = { lat: 35.0844, lon: -106.6504 };
const EAST = { dirX: 1, dirY: 0 };

type EngineInternals = {
  entities: Map<string, {
    position: LatLon;
    homePosition: LatLon;
    currentHealth: number;
    targetEntityId: string | null;
    scheduledAttackTick: number | null;
    aggroOwnerPlayerId: string | null;
    special?: { hitstunUntilTick: number };
  }>;
  positionHistory: {
    sampleCount(id: string): number;
    positionAtTick(id: string, tick: number, fallback: LatLon, out: LatLon): LatLon;
  };
  returningMobs: Set<string>;
  setMobPosition(mob: unknown, position: LatLon, teleport?: boolean): void;
  currentTick: number;
};

function internals(engine: CombatEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

function at(distanceM: number, bearing: number, from: LatLon = origin): LatLon {
  return destinationPoint(from, distanceM, bearing);
}

function createEngine(overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  let clock = 1_000_000;
  const engine = new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    actionCombatEnabled: () => true,
    now: () => clock,
    ...overrides
  });
  // Advance the injected clock with every tick (50 ms at 20 Hz).
  const tick = engine.tick.bind(engine);
  engine.tick = () => {
    clock += 50;
    tick();
  };
  return engine;
}

function addPlayer(engine: CombatEngine, playerId: string, position: LatLon = origin, damage = 10): void {
  engine.connectPlayer({
    playerId,
    name: playerId,
    regionCode: "NM",
    zoneId: "world:NM",
    position,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth: 100, baseAttackDamage: damage }
  });
}

function spawnWolf(engine: CombatEngine, entityId: string, position: LatLon, worldAi = false): string {
  return engine.spawnMob({
    entityId, archetype: "wolf", position, regionCode: "NM", zoneId: "world:NM", ...(worldAi ? { worldAi } : {})
  }).entityId;
}

let nextSeq = 1;
function swing(engine: CombatEngine, playerId = "p1", input: Partial<SwingInput> = {}): SwingResolution {
  return engine.resolveSwing(playerId, { seq: nextSeq++, ...EAST, lagMs: 0, ...input });
}

function hitIds(result: SwingResolution): string[] {
  return result.hits.map((hit) => hit.entityId);
}

function waitTicks(engine: CombatEngine, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) engine.tick();
}

describe("CombatEngine.resolveSwing", () => {
  it("rejects every swing with 'disabled' while the flag is off", () => {
    const engine = createEngine({ actionCombatEnabled: () => false });
    addPlayer(engine, "p1");
    spawnWolf(engine, "wolf", at(50, 90));
    const result = swing(engine);
    expect(result.rejected).toBe("disabled");
    expect(result.hits).toEqual([]);
    expect(engine.swingMetricsSnapshot().swingRejected).toBe(1);
  });

  it("hits a mob in the arc, emits a SWING event and flushes immediately", () => {
    const engine = createEngine();
    addPlayer(engine, "p1");
    spawnWolf(engine, "wolf", at(60, 90));
    engine.beginDeltaFlush();
    const result = swing(engine);
    expect(result.rejected).toBeUndefined();
    expect(result.comboIndex).toBe(0);
    expect(hitIds(result)).toEqual(["wolf"]);
    expect(result.hits[0]!.damage).toBeGreaterThan(0);
    expect(engine.takeImmediateFlush()).toBe(true);
    expect(engine.takeImmediateFlush()).toBe(false);
    const events = engine.beginDeltaFlush().events;
    const swingEvent = events.find((event) => event.type === "SWING");
    expect(swingEvent).toMatchObject({ sourceEntityId: "p1", abilityId: "swing_0", radiusM: SWING_RANGE_M });
    expect(swingEvent!.facingDegrees).toBeCloseTo(90, 6);
    expect(events.some((event) => event.type === "DAMAGE" && event.targetEntityId === "wolf")).toBe(true);
    expect(engine.swingMetricsSnapshot()).toMatchObject({ swingsResolved: 1, swingHits: 1, swingRejected: 0 });
  });

  it("resolves a swing against a dungeon run's mob at room-local positions", () => {
    const engine = createEngine();
    const room = { lat: 0, lon: 0 };
    const regionCode = "interior:run-1";
    const zoneId = "interior:run-1:room_1";
    engine.connectPlayer({
      playerId: "p1", name: "p1", regionCode, zoneId, position: room,
      accountId: "account-p1", connectionId: "connection-p1",
      profile: { playerId: "p1", maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
    });
    engine.spawnMob({ entityId: "vault-wolf", archetype: "wolf", position: at(60, 90, room), regionCode, zoneId });
    // A mob of another run, same spot: never hit.
    engine.spawnMob({
      entityId: "other-run-wolf", archetype: "wolf", position: at(50, 90, room),
      regionCode: "interior:run-2", zoneId: "interior:run-2:room_1"
    });
    const before = engine.entity("vault-wolf")!.currentHealth;
    const result = swing(engine);
    expect(result.rejected).toBeUndefined();
    expect(hitIds(result)).toEqual(["vault-wolf"]);
    expect(engine.entity("vault-wolf")!.currentHealth).toBeLessThan(before);
  });

  it("misses a mob behind the player and hits one point blank regardless of angle", () => {
    const engine = createEngine();
    addPlayer(engine, "p1");
    spawnWolf(engine, "behind", at(60, 270));
    spawnWolf(engine, "close", at(15, 270));
    expect(hitIds(swing(engine))).toEqual(["close"]);
  });

  it("hits only the SWING_MAX_TARGETS nearest mobs (one by default)", () => {
    const engine = createEngine();
    addPlayer(engine, "p1");
    for (const [index, distance] of [80, 30, 95, 50, 40, 70].entries()) {
      spawnWolf(engine, `wolf-${index}`, at(distance, 90 + (index % 2 === 0 ? 10 : -10)));
    }
    expect(hitIds(swing(engine))).toEqual(["wolf-1", "wolf-4", "wolf-3", "wolf-5"].slice(0, SWING_MAX_TARGETS));
  });

  it("rewinds mob positions by the lag hint", () => {
    const run = (lagMs: number) => {
      const engine = createEngine({ mobAiEnabled: () => false });
      addPlayer(engine, "p1");
      spawnWolf(engine, "wolf", at(80, 90));
      waitTicks(engine, 4);
      const state = internals(engine);
      // 200 ms after it stood east of the player, the wolf is north of it (out of the arc).
      state.setMobPosition(state.entities.get("wolf"), at(90, 0));
      return swing(engine, "p1", { lagMs });
    };
    expect(hitIds(run(200))).toEqual(["wolf"]);
    expect(hitIds(run(0))).toEqual([]);
  });

  it("gates on recovery, buffers one early press, and keeps seq monotonic", () => {
    const onSwingResolved = vi.fn();
    const engine = createEngine({ onSwingResolved });
    addPlayer(engine, "p1");
    spawnWolf(engine, "wolf", at(60, 90));
    const first = engine.resolveSwing("p1", { seq: 10, ...EAST, lagMs: 0, requestId: "r10" });
    expect(first.hits).toHaveLength(1);
    const startTick = first.serverTick;
    expect(first.nextSwingAtMs).toBe(1_000_000 + SWING_RECOVERY_TICKS[0] * 50);
    // Too early to buffer (6 ticks of recovery left).
    expect(engine.resolveSwing("p1", { seq: 11, ...EAST, lagMs: 0 }).rejected).toBe("too_soon");
    waitTicks(engine, SWING_RECOVERY_TICKS[0] - 3);
    // A stale seq is refused before anything else.
    expect(engine.resolveSwing("p1", { seq: 11, ...EAST, lagMs: 0 }).rejected).toBe("unavailable");
    const buffered = engine.resolveSwing("p1", { seq: 12, ...EAST, lagMs: 0, requestId: "r12" });
    expect(buffered).toMatchObject({ buffered: true, hits: [] });
    // The single slot is taken.
    expect(engine.resolveSwing("p1", { seq: 13, ...EAST, lagMs: 0 }).rejected).toBe("too_soon");
    waitTicks(engine, 2);
    expect(onSwingResolved).not.toHaveBeenCalled();
    engine.tick();
    expect(onSwingResolved).toHaveBeenCalledTimes(1);
    const [playerId, deferred] = onSwingResolved.mock.calls[0] as [string, SwingResolution];
    expect(playerId).toBe("p1");
    expect(deferred).toMatchObject({ seq: 12, requestId: "r12", comboIndex: 1 });
    expect(deferred.serverTick).toBe(startTick + SWING_RECOVERY_TICKS[0]);
    expect(deferred.rejected).toBeUndefined();
  });

  it("restarts the seq sequence on a new connection", () => {
    const engine = createEngine();
    addPlayer(engine, "p1");
    expect(engine.resolveSwing("p1", { seq: 5, ...EAST, lagMs: 0, connectionId: "c1" }).rejected).toBeUndefined();
    waitTicks(engine, SWING_RECOVERY_TICKS[0]);
    expect(engine.resolveSwing("p1", { seq: 0, ...EAST, lagMs: 0, connectionId: "c1" }).rejected).toBe("unavailable");
    expect(engine.resolveSwing("p1", { seq: 0, ...EAST, lagMs: 0, connectionId: "c2" }).rejected).toBeUndefined();
  });

  it("buffers a swing during a dash until it lands, and a dash clears recovery", () => {
    let dashing = false;
    const onSwingResolved = vi.fn();
    const engine = createEngine({ isEntityDashing: () => dashing, onSwingResolved });
    addPlayer(engine, "p1");
    spawnWolf(engine, "wolf", at(60, 90));
    expect(swing(engine).hits).toHaveLength(1);
    engine.notePlayerDashed("p1");
    dashing = true;
    expect(swing(engine).buffered).toBe(true);
    expect(swing(engine).rejected).toBe("dashing");
    waitTicks(engine, 3);
    expect(onSwingResolved).not.toHaveBeenCalled();
    dashing = false;
    engine.tick();
    expect(onSwingResolved).toHaveBeenCalledTimes(1);
    expect((onSwingResolved.mock.calls[0]![1] as SwingResolution).hits).toHaveLength(1);
  });

  it("cancels the queued auto-attack, and START_ATTACK resets the swing recovery", () => {
    const engine = createEngine();
    addPlayer(engine, "p1");
    spawnWolf(engine, "wolf", at(60, 90));
    engine.startAttack({
      attackerId: "p1", targetEntityId: "wolf", requestId: "a1",
      accountId: "account-p1", connectionId: "connection-p1"
    });
    expect(internals(engine).entities.get("p1")!.targetEntityId).toBe("wolf");
    expect(swing(engine).hits).toHaveLength(1);
    const player = internals(engine).entities.get("p1")!;
    expect(player.targetEntityId).toBeNull();
    expect(player.scheduledAttackTick).toBeNull();
    expect(swing(engine).rejected).toBe("too_soon");
    engine.startAttack({
      attackerId: "p1", targetEntityId: "wolf", requestId: "a2",
      accountId: "account-p1", connectionId: "connection-p1"
    });
    expect(swing(engine).rejected).toBeUndefined();
  });

  it("skips a mob owned by another player's session", () => {
    const engine = createEngine();
    addPlayer(engine, "p1");
    addPlayer(engine, "p2");
    spawnWolf(engine, "wolf", at(60, 90));
    expect(hitIds(swing(engine, "p2"))).toEqual(["wolf"]);
    expect(internals(engine).entities.get("wolf")!.aggroOwnerPlayerId).toBe("p2");
    expect(hitIds(swing(engine, "p1"))).toEqual([]);
  });

  it("skips dead and invulnerable mobs", () => {
    const engine = createEngine({ isEntityInvulnerable: (id) => id === "dashing-mob" });
    addPlayer(engine, "p1", origin, 100);
    spawnWolf(engine, "dead", at(40, 90));
    spawnWolf(engine, "immune", at(50, 90));
    spawnWolf(engine, "dashing-mob", at(55, 90));
    engine.setMobInvulnerable("immune", true);
    internals(engine).entities.get("dead")!.currentHealth = 1;
    expect(hitIds(swing(engine))).toEqual(["dead"]);
    expect(engine.entity("dead")?.lifeState ?? "removed").not.toBe("alive");
    waitTicks(engine, 20);
    expect(hitIds(swing(engine))).toEqual([]);
  });

  it("does not move a surviving mob (knockback is off) and holds its chase and strike during hitstun", () => {
    const engine = createEngine();
    addPlayer(engine, "p1");
    spawnWolf(engine, "wolf", at(60, 90));
    const state = internals(engine);
    const before = distanceMeters(origin, state.entities.get("wolf")!.position);
    const result = swing(engine);
    expect(hitIds(result)).toEqual(["wolf"]);
    const wolf = state.entities.get("wolf")!;
    expect(distanceMeters(origin, wolf.position)).toBeCloseTo(before, 6);
    expect(wolf.special!.hitstunUntilTick).toBe(result.serverTick + SWING_HITSTUN_TICKS);
    // Stretch the hitstun so the hold is unambiguous: no step, no strike, until it ends.
    wolf.special!.hitstunUntilTick = result.serverTick + 60;
    const heldAt = { ...wolf.position };
    engine.beginDeltaFlush();
    let firstStrikeTick: number | null = null;
    for (let index = 0; index < 120 && firstStrikeTick === null; index += 1) {
      engine.tick();
      const strike = engine.beginDeltaFlush().events.find((event) =>
        event.type === "DAMAGE" && event.sourceEntityId === "wolf" && event.targetEntityId === "p1");
      if (strike) firstStrikeTick = strike.tick;
      if (internals(engine).currentTick < result.serverTick + 60) {
        expect(state.entities.get("wolf")!.position).toEqual(heldAt);
      }
    }
    expect(firstStrikeTick).not.toBeNull();
    expect(firstStrikeTick!).toBeGreaterThanOrEqual(result.serverTick + 60);
  });

  it("scales damage by the combo factor", () => {
    const baselineEngine = createEngine({ mobAiEnabled: () => false });
    addPlayer(baselineEngine, "p1", origin, 40);
    spawnWolf(baselineEngine, "wolf", at(60, 90));
    internals(baselineEngine).entities.get("wolf")!.currentHealth = 10_000;
    baselineEngine.startAttack({
      attackerId: "p1", targetEntityId: "wolf", requestId: "base",
      accountId: "account-p1", connectionId: "connection-p1"
    });
    let baseline = 0;
    for (let index = 0; index < 40 && baseline === 0; index += 1) {
      baselineEngine.tick();
      baseline = baselineEngine.beginDeltaFlush().events.find((event) =>
        event.type === "DAMAGE" && event.sourceEntityId === "p1")?.amount ?? 0;
    }
    expect(baseline).toBeGreaterThan(0);

    const engine = createEngine({ mobAiEnabled: () => false });
    addPlayer(engine, "p1", origin, 40);
    spawnWolf(engine, "wolf", at(60, 90));
    internals(engine).entities.get("wolf")!.currentHealth = 10_000;
    const damages: number[] = [];
    for (let step = 0; step < 3; step += 1) {
      const result = swing(engine);
      expect(result.comboIndex).toBe(step);
      damages.push(result.hits[0]!.damage);
      waitTicks(engine, SWING_RECOVERY_TICKS[step as 0 | 1 | 2]);
    }
    damages.forEach((damage, step) => {
      expect(Math.abs(damage - baseline * SWING_DAMAGE_FACTORS[step as 0 | 1 | 2])).toBeLessThanOrEqual(1);
    });
  });

  it("applies the sword combo factor after the v4 matrix and level factor (DAMAGE_MATRIX_V4_ENABLED)", () => {
    const onSwingResolved = vi.fn();
    const engine = createEngine({ mobAiEnabled: () => false, damageMatrixV4Enabled: () => true, onSwingResolved });
    addPlayer(engine, "p1");
    equipWeapon(engine, "p1", "starter_sword");
    spawnWolf(engine, "wolf", at(60, 90));
    internals(engine).entities.get("wolf")!.currentHealth = 10_000;
    const wolfLevel = engine.entity("wolf")!.level;
    for (let step = 0; step < 3; step += 1) {
      swing(engine);
      // A sword swing lands at its contact frame (sword:generic windup, at most 3 ticks).
      waitTicks(engine, 4);
      const result = onSwingResolved.mock.calls[step]![1] as SwingResolution;
      // Sword (Slash, base 8) into the Wolf's fur (Leather 1.15), weapon level 0 against the Wolf's level.
      expect(result.hits[0]!.damage).toBe(resolveDamageMatrixV4({
        damageType: "slash", baseDamage: 8, armourType: "leather", attackerLevel: 0, defenderLevel: wolfLevel,
        multiplier: SWORD_GENERIC_ATTACK_PROFILE.combo[step]!.damageMultiplier
      }).finalDamage);
      waitTicks(engine, SWING_RECOVERY_TICKS[step as 0 | 1 | 2]);
    }
  });

  it("routes a kill through the player's session for loot and XP", () => {
    const onDefeatSettlementCandidate = vi.fn();
    const engine = createEngine({ onDefeatSettlementCandidate });
    addPlayer(engine, "p1");
    spawnWolf(engine, "wolf", at(60, 90));
    internals(engine).entities.get("wolf")!.currentHealth = 1;
    expect(hitIds(swing(engine))).toEqual(["wolf"]);
    engine.tick();
    expect(onDefeatSettlementCandidate).toHaveBeenCalledTimes(1);
    expect(onDefeatSettlementCandidate).toHaveBeenCalledWith(expect.objectContaining({
      defeatedEntityId: "wolf",
      defeatingPlayerId: "p1",
      eligibleParticipantIds: ["p1"],
      mobArchetype: "wolf"
    }));
  });
});

describe("CombatEngine mob position writes", () => {
  it("records history on every write path", () => {
    const far = at(3_000, 90);
    const engine = createEngine({ canMobProactivelyAcquire: () => true });
    const state = internals(engine);
    const history = state.positionHistory;

    // Spawn.
    spawnWolf(engine, "wolf", far);
    expect(history.sampleCount("wolf")).toBe(1);

    // Teleport (relocate) resets the history.
    waitTicks(engine, 1);
    expect(engine.relocateMob("wolf", at(20, 0, far))).toBe(true);
    expect(history.sampleCount("wolf")).toBe(1);

    // commitMobPhysicalPosition / placeMobAtFirstTraversable (scripted leap).
    waitTicks(engine, 1);
    expect(engine.leapMobTo("wolf", at(80, 0, far))).toBe(true);
    expect(history.sampleCount("wolf")).toBe(2);

    // Return home.
    state.returningMobs.add("wolf");
    const countBefore = history.sampleCount("wolf");
    waitTicks(engine, 2);
    expect(history.sampleCount("wolf")).toBeGreaterThan(countBefore);
    const wolf = state.entities.get("wolf")!;
    expect(distanceMeters(wolf.position, wolf.homePosition)).toBeLessThan(60);

    // Chase (processChases): a swing claims the wolf, then the player walks away and it pursues.
    const playerAt = at(400, 270, far);
    addPlayer(engine, "p1", playerAt);
    spawnWolf(engine, "chaser", at(60, 90, playerAt));
    expect(hitIds(swing(engine))).toEqual(["chaser"]);
    engine.syncPlayer({ playerId: "p1", position: at(150, 270, playerAt), regionCode: "NM", zoneId: "world:NM" });
    const chaseStart = { ...state.entities.get("chaser")!.position };
    waitTicks(engine, 30);
    expect(engine.entity("chaser")?.activityState).toBe("chasing");
    const chaser = state.entities.get("chaser")!;
    expect(chaser.position).not.toEqual(chaseStart);
    expect(history.sampleCount("chaser")).toBeGreaterThan(1);
    const rewound = history.positionAtTick("chaser", state.currentTick - 1.5, chaser.position, { lat: 0, lon: 0 });
    expect(Number.isFinite(rewound.lat)).toBe(true);

    // Swing knockback is off (0 m): a hit leaves the mob where it stood, so no extra history sample.
    const knockEngine = createEngine();
    addPlayer(knockEngine, "p1");
    spawnWolf(knockEngine, "wolf", at(60, 90));
    const knockHistory = internals(knockEngine).positionHistory;
    expect(knockHistory.sampleCount("wolf")).toBe(1);
    waitTicks(knockEngine, 1);
    swing(knockEngine);
    expect(knockHistory.sampleCount("wolf")).toBe(SWING_KNOCKBACK_M.some((m) => m > 0) ? 2 : 1);

    // Removal releases the ring.
    knockEngine.clearMobs();
    expect(knockHistory.sampleCount("wolf")).toBe(0);
  });
});

/** Readies one weapon (a bow goes in the secondary slot, a melee weapon in the melee slot). */
function equipWeapon(engine: CombatEngine, playerId: string, definitionId: EquipmentDefinitionId): void {
  const weapon = requireEquipmentDefinition(definitionId);
  const slot = weapon.category === "ranged_weapon" ? "secondary" as const : "melee" as const;
  const loadout: ActiveEquipmentLoadout = { active: emptyEquipmentSlots(null), readiedWeaponSlot: slot };
  const instanceId = `weapon-${definitionId}`;
  loadout.active[slot] = { instanceId, definition: weapon, itemLevel: 0 };
  const stats = resolveEquipmentCombatStats({
    context: "pvp_open_world", characterLevel: 25, classId: "warrior", classRank: 0, loadout
  });
  const empty = { instanceId: null, definitionId: null, category: null, enchantmentIdentity: null };
  const filled = { instanceId, definitionId: weapon.definitionId, category: weapon.weaponCategory, enchantmentIdentity: null };
  const state: PlayerEquipmentCombatState = {
    activeKitIndex: 1,
    inventoryRevision: 1,
    activeRevision: 1,
    stats,
    weaponCategory: weapon.weaponCategory,
    chestArmorCategory: null,
    chestDefinitionId: null,
    heavyArmorPieces: 0,
    hasShield: false,
    activeWeaponInstanceId: instanceId,
    activeWeaponEnchantmentIdentity: null,
    armorEnchantmentIdentities: { head: null, chest: null, gloves: null, boots: null },
    weaponSlots: { melee: slot === "melee" ? filled : empty, secondary: slot === "secondary" ? filled : empty },
    activeWeaponSlot: slot,
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  };
  expect(engine.syncPlayerEquipmentCombatState(playerId, state)).not.toBeNull();
}

function swingEvent(engine: CombatEngine) {
  return engine.beginDeltaFlush().events.find((event) => event.type === "SWING");
}

describe("CombatEngine.resolveSwing with a staff or wand (arcane blast)", () => {
  function caster(definitionId: EquipmentDefinitionId = "starter_staff", damage = 10): CombatEngine {
    const engine = createEngine({ mobAiEnabled: () => false });
    addPlayer(engine, "p1", origin, damage);
    equipWeapon(engine, "p1", definitionId);
    return engine;
  }

  it("a staff shoots instead of swinging: first mob on the line at range, a shot SWING event, no windup", () => {
    const engine = caster();
    spawnWolf(engine, "far", at(260, 90));
    spawnWolf(engine, "near", at(220, 90));
    engine.beginDeltaFlush();
    const result = swing(engine);
    expect(result.rejected).toBeUndefined();
    expect(result.buffered).toBeUndefined();
    expect(hitIds(result)).toEqual(["near"]);
    expect(result.comboIndex).toBe(0);
    const event = swingEvent(engine);
    expect(event).toMatchObject({ sourceEntityId: "p1", abilityId: "shot", targetEntityId: "near" });
    expect(event!.radiusM).toBeCloseTo(220, 0);
  });

  it("a wand casts the same blast", () => {
    const engine = caster("starter_wand");
    spawnWolf(engine, "wolf", at(200, 90));
    expect(hitIds(swing(engine))).toEqual(["wolf"]);
  });

  it("misses past the arcane blast range and reaches its full range", () => {
    const engine = caster();
    spawnWolf(engine, "beyond", at(ARCANE_BLAST_SHOT_PROFILE.rangeM + 60, 90));
    engine.beginDeltaFlush();
    expect(hitIds(swing(engine))).toEqual([]);
    expect(swingEvent(engine)).toMatchObject({ abilityId: "shot", targetEntityId: null, radiusM: ARCANE_BLAST_SHOT_PROFILE.rangeM });
  });

  it("recovers for the arcane blast's own ticks (longer than the bow's)", () => {
    const early = caster();
    swing(early);
    waitTicks(early, ARCANE_BLAST_SHOT_PROFILE.recoveryTicks - (SWING_BUFFER_EARLY_TICKS + 1));
    expect(swing(early).rejected).toBe("too_soon");
    const onTime = caster();
    spawnWolf(onTime, "wolf", at(120, 90));
    swing(onTime);
    waitTicks(onTime, SHOT_RECOVERY_TICKS);
    expect(swing(onTime).buffered).toBe(true);
    const later = caster();
    spawnWolf(later, "wolf", at(120, 90));
    swing(later);
    waitTicks(later, ARCANE_BLAST_SHOT_PROFILE.recoveryTicks);
    const second = swing(later);
    expect(second.rejected).toBeUndefined();
    expect(second.buffered).toBeUndefined();
    expect(hitIds(second)).toEqual(["wolf"]);
  });

  it("deals the arcane blast damage factor of the staff's basic hit", () => {
    const setup = (): CombatEngine => {
      const engine = caster("starter_staff", 40);
      spawnWolf(engine, "wolf", at(60, 90));
      internals(engine).entities.get("wolf")!.currentHealth = 10_000;
      return engine;
    };
    const baselineEngine = setup();
    baselineEngine.startAttack({
      attackerId: "p1", targetEntityId: "wolf", requestId: "base", accountId: "account-p1", connectionId: "connection-p1"
    });
    let baseline = 0;
    for (let index = 0; index < 40 && baseline === 0; index += 1) {
      baselineEngine.tick();
      baseline = baselineEngine.beginDeltaFlush().events.find((event) =>
        event.type === "DAMAGE" && event.sourceEntityId === "p1")?.amount ?? 0;
    }
    expect(baseline).toBeGreaterThan(0);
    const blast = swing(setup()).hits[0]!.damage;
    expect(Math.abs(blast - baseline * ARCANE_BLAST_SHOT_PROFILE.damageFactor)).toBeLessThanOrEqual(1);
  });
});

describe("CombatEngine.resolveSwing with a ranged weapon (shot)", () => {
  function archer(): CombatEngine {
    const engine = createEngine({ mobAiEnabled: () => false });
    addPlayer(engine, "p1");
    equipWeapon(engine, "p1", "starter_bow");
    return engine;
  }

  it("hits only the first mob on the line, not the one behind it, and emits a shot SWING event", () => {
    const engine = archer();
    spawnWolf(engine, "far", at(250, 90));
    spawnWolf(engine, "near", at(150, 90));
    engine.beginDeltaFlush();
    const result = swing(engine);
    expect(result.rejected).toBeUndefined();
    expect(hitIds(result)).toEqual(["near"]);
    expect(result.comboIndex).toBe(0);
    const events = engine.beginDeltaFlush().events;
    const shot = events.find((event) => event.type === "SWING");
    expect(shot).toMatchObject({ sourceEntityId: "p1", abilityId: "shot", targetEntityId: "near" });
    expect(shot!.radiusM).toBeCloseTo(150, 0);
    expect(shot!.facingDegrees).toBeCloseTo(90, 6);
    expect(events.some((event) => event.type === "DAMAGE" && event.targetEntityId === "far")).toBe(false);
  });

  it("misses a mob off the line and one out of range, reaching full range", () => {
    const engine = archer();
    spawnWolf(engine, "offline", at(150, 30));
    spawnWolf(engine, "beyond", at(SHOT_RANGE_M + 40, 90));
    engine.beginDeltaFlush();
    expect(hitIds(swing(engine))).toEqual([]);
    expect(swingEvent(engine)).toMatchObject({ abilityId: "shot", targetEntityId: null, radiusM: SHOT_RANGE_M });
  });

  it("recovers for SHOT_RECOVERY_TICKS, never combos, applies hitstun and no knockback", () => {
    const engine = archer();
    spawnWolf(engine, "wolf", at(120, 90));
    const state = internals(engine);
    const before = { ...state.entities.get("wolf")!.position };
    const first = swing(engine);
    expect(hitIds(first)).toEqual(["wolf"]);
    expect(state.entities.get("wolf")!.position).toEqual(before);
    expect(state.entities.get("wolf")!.special!.hitstunUntilTick).toBe(first.serverTick + SWING_HITSTUN_TICKS);
    waitTicks(engine, SHOT_RECOVERY_TICKS - 1);
    expect(swing(engine).buffered).toBe(true);
    const tooSoonEngine = archer();
    swing(tooSoonEngine);
    waitTicks(tooSoonEngine, SHOT_RECOVERY_TICKS - (SWING_BUFFER_EARLY_TICKS + 1));
    expect(swing(tooSoonEngine).rejected).toBe("too_soon");
    const onTime = archer();
    spawnWolf(onTime, "wolf", at(120, 90));
    swing(onTime);
    waitTicks(onTime, SHOT_RECOVERY_TICKS);
    const second = swing(onTime);
    expect(second.rejected).toBeUndefined();
    expect(second.buffered).toBeUndefined();
    expect(second.comboIndex).toBe(0);
  });

  it("deals SHOT_DAMAGE_FACTOR where the first combo swing deals its own factor", () => {
    const setup = (): CombatEngine => {
      const engine = createEngine({ mobAiEnabled: () => false });
      addPlayer(engine, "p1", origin, 40);
      equipWeapon(engine, "p1", "starter_bow");
      spawnWolf(engine, "wolf", at(60, 90));
      internals(engine).entities.get("wolf")!.currentHealth = 10_000;
      return engine;
    };
    // Baseline: the same bow's plain auto-attack hit.
    const baselineEngine = setup();
    baselineEngine.startAttack({
      attackerId: "p1", targetEntityId: "wolf", requestId: "base", accountId: "account-p1", connectionId: "connection-p1"
    });
    let baseline = 0;
    for (let index = 0; index < 40 && baseline === 0; index += 1) {
      baselineEngine.tick();
      baseline = baselineEngine.beginDeltaFlush().events.find((event) =>
        event.type === "DAMAGE" && event.sourceEntityId === "p1")?.amount ?? 0;
    }
    expect(baseline).toBeGreaterThan(0);
    const shot = swing(setup()).hits[0]!.damage;
    expect(Math.abs(shot - baseline * SHOT_DAMAGE_FACTOR)).toBeLessThanOrEqual(1);
  });

  it("a melee weapon still swings (a sword plays sword:generic: the hit lands at its 100 ms contact)", () => {
    const onSwingResolved = vi.fn();
    const engine = createEngine({ mobAiEnabled: () => false, onSwingResolved });
    addPlayer(engine, "p1");
    equipWeapon(engine, "p1", "starter_sword");
    spawnWolf(engine, "wolf", at(60, 90));
    spawnWolf(engine, "far", at(200, 90));
    engine.beginDeltaFlush();
    expect(swing(engine)).toMatchObject({ buffered: true, hits: [] });
    expect(swingEvent(engine)).toMatchObject({ abilityId: "swing_0@sword:generic", radiusM: SWING_RANGE_M, targetEntityId: null });
    waitTicks(engine, 2);
    expect(hitIds(onSwingResolved.mock.calls[0]![1] as SwingResolution)).toEqual(["wolf"]);
  });

  it("rewinds mob positions by the lag hint", () => {
    const run = (lagMs: number) => {
      const engine = archer();
      spawnWolf(engine, "wolf", at(200, 90));
      waitTicks(engine, 4);
      const state = internals(engine);
      // 200 ms after it stood on the line east of the player, the wolf is north of it (off the line).
      state.setMobPosition(state.entities.get("wolf"), at(200, 0));
      return swing(engine, "p1", { lagMs });
    };
    expect(hitIds(run(200))).toEqual(["wolf"]);
    expect(hitIds(run(0))).toEqual([]);
  });
});
