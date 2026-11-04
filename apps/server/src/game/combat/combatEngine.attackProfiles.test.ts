import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  destinationPoint,
  emptyEquipmentSlots,
  equalDpsDamageMultipliers,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  SWING_BUFFER_EARLY_TICKS,
  SWING_RECOVERY_TICKS,
  SWORD_RONIN_ATTACK_PROFILE,
  AXE_WARRIOR_ATTACK_PROFILE,
  DEFAULT_ATTACK_PROFILE,
  type ActiveEquipmentLoadout,
  type AttackProfile,
  type EquipmentDefinitionId,
  type LatLon
} from "@ash-atlas/shared";
import {
  CombatEngine,
  type PlayerEquipmentCombatState,
  type SwingInput,
  type SwingResolution
} from "./combatEngine.js";

/** Tests swap the profile every style resolves to; null = the real profile. */
const profileHook = vi.hoisted(() => ({ override: null as unknown }));

vi.mock("@ash-atlas/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ash-atlas/shared")>();
  return {
    ...actual,
    attackProfileForStyle: vi.fn((style: string | null | undefined) =>
      (profileHook.override as AttackProfile | null) ?? actual.attackProfileForStyle(style))
  };
});

const shared = await import("@ash-atlas/shared");

const origin = { lat: 35.0844, lon: -106.6504 };
const EAST = { dirX: 1, dirY: 0 };

const at = (distanceM: number, bearing: number): LatLon => destinationPoint(origin, distanceM, bearing);

function createEngine(overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  let clock = 1_000_000;
  const engine = new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    actionCombatEnabled: () => true,
    mobAiEnabled: () => false,
    now: () => clock,
    ...overrides
  });
  const tick = engine.tick.bind(engine);
  engine.tick = () => {
    clock += 50;
    tick();
  };
  return engine;
}

function addPlayer(engine: CombatEngine, damage = 100): void {
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: "NM", zoneId: "world:NM", position: origin,
    accountId: "account-p1", connectionId: "connection-p1",
    profile: { playerId: "p1", maxHealth: 100, currentHealth: 100, baseAttackDamage: damage }
  });
}

/** A wolf 60 m east that does not die during the test. */
function spawnDummy(engine: CombatEngine): void {
  engine.spawnMob({ entityId: "wolf", archetype: "wolf", position: at(60, 90), regionCode: "NM", zoneId: "world:NM" });
  const entities = (engine as unknown as { entities: Map<string, { currentHealth: number; maxHealth: number }> }).entities;
  const wolf = entities.get("wolf")!;
  wolf.maxHealth = 10_000_000;
  wolf.currentHealth = 10_000_000;
}

function wolfHealth(engine: CombatEngine): number {
  return engine.entity("wolf")!.currentHealth;
}

function equipWeapon(engine: CombatEngine, definitionId: EquipmentDefinitionId): void {
  const weapon = requireEquipmentDefinition(definitionId);
  const loadout: ActiveEquipmentLoadout = { active: emptyEquipmentSlots(null), readiedWeaponSlot: "melee" };
  const instanceId = `weapon-${definitionId}`;
  loadout.active.melee = { instanceId, definition: weapon, itemLevel: 0 };
  const stats = resolveEquipmentCombatStats({
    context: "pvp_open_world", characterLevel: 25, classId: "warrior", classRank: 0, loadout
  });
  const empty = { instanceId: null, definitionId: null, category: null, enchantmentIdentity: null };
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
    weaponSlots: {
      melee: { instanceId, definitionId: weapon.definitionId, category: weapon.weaponCategory, enchantmentIdentity: null },
      secondary: empty
    },
    activeWeaponSlot: "melee",
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  };
  expect(engine.syncPlayerEquipmentCombatState("p1", state)).not.toBeNull();
}

let nextSeq = 1;
function swing(engine: CombatEngine, input: Partial<SwingInput> = {}): SwingResolution {
  return engine.resolveSwing("p1", { seq: nextSeq++, ...EAST, lagMs: 0, ...input });
}

function waitTicks(engine: CombatEngine, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) engine.tick();
}

function currentTick(engine: CombatEngine): number {
  return (engine as unknown as { currentTick: number }).currentTick;
}

/** Swings a chained combo `steps` times, pressing the tick recovery ends; returns damage and ticks spent. */
function chain(
  engine: CombatEngine,
  steps: number,
  results: SwingResolution[] = []
): { damage: number; ticks: number; combos: number[]; gaps: number[] } {
  const startHealth = wolfHealth(engine);
  const startTick = currentTick(engine);
  const combos: number[] = [];
  const gaps: number[] = [];
  let lastTick = startTick;
  for (let index = 0; index < steps; index += 1) {
    // Pressed the tick recovery ends: accepted at once (a windup step answers `buffered` and lands later).
    const result = swing(engine);
    expect(result.rejected).toBeUndefined();
    if (!result.buffered) results.push(result);
    combos.push(result.comboIndex);
    if (index > 0) gaps.push(currentTick(engine) - lastTick);
    lastTick = currentTick(engine);
    // Wait out the recovery so the next press is accepted at once (never buffered).
    while (swingWouldBeTooSoon(engine)) engine.tick();
  }
  return { damage: startHealth - wolfHealth(engine), ticks: currentTick(engine) - startTick, combos, gaps };
}

function swingWouldBeTooSoon(engine: CombatEngine): boolean {
  const state = (engine as unknown as { swingStates: Map<string, { nextSwingTick: number }> }).swingStates.get("p1")!;
  return currentTick(engine) < state.nextSwingTick;
}

function swingEventIds(engine: CombatEngine): string[] {
  return engine.beginDeltaFlush().events.filter((event) => event.type === "SWING").map((event) => event.abilityId ?? "");
}

function playerSnapshot(engine: CombatEngine) {
  return engine.snapshotForPlayer("p1").upserts.find((entity) => entity.entityId === "p1")!;
}

/** A made-up fast two-step combo that lands on the press (stands in for future animator numbers). */
const FAST_TWO_STEP: AttackProfile = {
  id: "test:fast",
  label: "Fast test combo",
  combo: [
    { windupMs: 100, recoveryMs: 400, damageMultiplier: 0.4, knockbackM: 0 },
    { windupMs: 120, recoveryMs: 480, damageMultiplier: 0.6, knockbackM: 0 }
  ],
  comboResetMs: 1_000,
  hitTiming: "press"
};

/** A slow two-step combo whose second step winds up 400 ms (the hit lands 8 ticks after the press). */
const SLOW_WINDUP: AttackProfile = {
  id: "test:slow",
  label: "Slow windup combo",
  combo: [
    { windupMs: 100, recoveryMs: 500, damageMultiplier: 0.5, knockbackM: 0 },
    { windupMs: 400, recoveryMs: 600, damageMultiplier: 1, knockbackM: 0 }
  ],
  comboResetMs: 1_500,
  hitTiming: "contact"
};

beforeEach(() => {
  profileHook.override = null;
  vi.mocked(shared.attackProfileForStyle).mockClear();
});

describe("CombatEngine swings read the combat style's attack profile", () => {
  it("an unarmed player keeps today's swing exactly: default style, damage on the press, 14/14/18 ticks", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawnDummy(engine);
    engine.beginDeltaFlush();
    expect(playerSnapshot(engine).combatStyle).toBeUndefined();
    const before = wolfHealth(engine);
    const first = swing(engine);
    expect(first.buffered).toBeUndefined();
    expect(first.hits).toHaveLength(1);
    expect(wolfHealth(engine)).toBeLessThan(before);
    expect(vi.mocked(shared.attackProfileForStyle)).toHaveBeenLastCalledWith("default");
    waitTicks(engine, SWING_RECOVERY_TICKS[0]);
    const run = chain(engine, 3);
    expect(run.combos).toEqual([1, 2, 0]);
    expect(run.gaps).toEqual([SWING_RECOVERY_TICKS[1], SWING_RECOVERY_TICKS[2]]);
    expect(swingEventIds(engine)).toEqual(["swing_0", "swing_1", "swing_2", "swing_0"]);
  });

  it("a sword holder plays sword:generic, and the combat snapshot carries the style", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawnDummy(engine);
    const revision = playerSnapshot(engine).revision;
    equipWeapon(engine, "starter_sword");
    const snapshot = playerSnapshot(engine);
    expect(snapshot.combatStyle).toBe("sword:generic");
    expect(snapshot.revision).toBeGreaterThan(revision);
    engine.beginDeltaFlush();
    const run = chain(engine, 4);
    expect(vi.mocked(shared.attackProfileForStyle)).toHaveBeenLastCalledWith("sword:generic");
    expect(run.combos).toEqual([0, 1, 2, 0]);
    // Next press 500 / 500 / 650 ms.
    expect(run.gaps).toEqual([10, 10, 13]);
    expect(swingEventIds(engine)).toEqual(["swing_0@sword:generic", "swing_1@sword:generic", "swing_2@sword:generic", "swing_0@sword:generic"]);
  });

  it("sword:generic resolves each hit at its contact time (100 / 100 / 133 ms), not on the press", () => {
    const onSwingResolved = vi.fn();
    const engine = createEngine({ onSwingResolved });
    addPlayer(engine);
    spawnDummy(engine);
    equipWeapon(engine, "starter_sword");
    const landedAfter: number[] = [];
    for (const expectedTicks of [2, 2, 3]) {
      const before = wolfHealth(engine);
      const press = swing(engine);
      expect(press).toMatchObject({ buffered: true, hits: [] });
      let ticks = 0;
      while (wolfHealth(engine) === before) {
        engine.tick();
        ticks += 1;
        expect(ticks).toBeLessThanOrEqual(expectedTicks);
      }
      landedAfter.push(ticks);
      expect(onSwingResolved.mock.lastCall![1]).toMatchObject({ seq: press.seq, comboIndex: press.comboIndex });
      while (swingWouldBeTooSoon(engine)) engine.tick();
    }
    expect(landedAfter).toEqual([2, 2, 3]);
    expect(onSwingResolved).toHaveBeenCalledTimes(3);
  });

  it("an axe holder plays axe:generic; axe hits land at contact (generic 200 / 200 / 300 ms, Warrior 233 / 133 / 367 ms)", () => {
    const landedFor = (profile: AttackProfile | null): { style: string | undefined; ticks: number[]; ids: string[] } => {
      profileHook.override = profile;
      const engine = createEngine();
      addPlayer(engine);
      spawnDummy(engine);
      equipWeapon(engine, "double_axe");
      const style = playerSnapshot(engine).combatStyle;
      engine.beginDeltaFlush();
      const ticks: number[] = [];
      for (let step = 0; step < 3; step += 1) {
        const before = wolfHealth(engine);
        expect(swing(engine)).toMatchObject({ buffered: true, hits: [] });
        let n = 0;
        while (wolfHealth(engine) === before && n < 20) {
          engine.tick();
          n += 1;
        }
        ticks.push(n);
        while (swingWouldBeTooSoon(engine)) engine.tick();
      }
      return { style, ticks, ids: swingEventIds(engine) };
    };
    const generic = landedFor(null);
    expect(generic.style).toBe("axe:generic");
    expect(vi.mocked(shared.attackProfileForStyle)).toHaveBeenLastCalledWith("axe:generic");
    expect(generic.ticks).toEqual([4, 4, 6]);
    expect(generic.ids).toEqual(["swing_0@axe:generic", "swing_1@axe:generic", "swing_2@axe:generic"]);
    // The Warrior's profile (the class mapping is covered by the shared resolver test): 233 / 133 / 367 ms round to ticks.
    expect(landedFor(AXE_WARRIOR_ATTACK_PROFILE).ticks).toEqual([5, 3, 7]);
  });

  it("follows a profile's own combo length, cadence and damage factors", () => {
    profileHook.override = FAST_TWO_STEP;
    const engine = createEngine();
    addPlayer(engine);
    spawnDummy(engine);
    engine.beginDeltaFlush();
    const first = swing(engine);
    expect(first.nextSwingAtMs).toBe(1_000_000 + 10 * 50);
    waitTicks(engine, 10);
    const second = swing(engine);
    expect(second.comboIndex).toBe(1);
    expect(second.hits[0]!.damage / first.hits[0]!.damage).toBeCloseTo(0.6 / 0.4, 1);
    waitTicks(engine, 12);
    expect(swing(engine).comboIndex).toBe(0);
    expect(swingEventIds(engine)).toEqual(["swing_0@test:fast", "swing_1@test:fast", "swing_0@test:fast"]);
  });

  it("keeps DPS equal across the default, sword:generic and sword:ronin over whole combos", () => {
    // Damage counted from the swings' own hits (press results and landed windups), over whole combos of cadence.
    const run = (profile: AttackProfile | null, weapon: EquipmentDefinitionId | null, steps: number) => {
      profileHook.override = profile;
      const landed: SwingResolution[] = [];
      const engine = createEngine({ onSwingResolved: (_playerId, result) => landed.push(result) });
      addPlayer(engine, 1_000);
      spawnDummy(engine);
      if (weapon) equipWeapon(engine, weapon);
      const result = chain(engine, steps, landed);
      const damage = landed.reduce((total, swingResult) => total + swingResult.hits.reduce((sum, hit) => sum + hit.damage, 0), 0);
      return damage / result.ticks;
    };
    // Same sword in every run: 6 default combos (13.8 s), 8 generic combos (13.2 s), 6 Ronin combos (14.7 s).
    const swordDefaultDps = run(DEFAULT_ATTACK_PROFILE, "starter_sword", 18);
    const genericDps = run(null, "starter_sword", 24);
    const roninDps = run(SWORD_RONIN_ATTACK_PROFILE, "starter_sword", 18);
    // Within 1 %: each hit's damage is a whole number (tens here), so rounding moves DPS by a few tenths of a percent.
    expect(Math.abs(genericDps / swordDefaultDps - 1)).toBeLessThan(0.01);
    expect(Math.abs(roninDps / swordDefaultDps - 1)).toBeLessThan(0.01);
    const defaultDps = run(null, null, 18);
    // Factors set from the cadence by the shared helper hold on a made-up combo too.
    const multipliers = equalDpsDamageMultipliers(SLOW_WINDUP.combo);
    const tuned: AttackProfile = {
      ...SLOW_WINDUP,
      combo: SLOW_WINDUP.combo.map((step, index) => ({ ...step, damageMultiplier: multipliers[index]! }))
    };
    expect(Math.abs(run(tuned, null, 14) / defaultDps - 1)).toBeLessThan(0.01);
  });
});

describe("CombatEngine swing windup (contact hit timing)", () => {
  function windupEngine(onSwingResolved = vi.fn()) {
    profileHook.override = SLOW_WINDUP;
    const engine = createEngine({ onSwingResolved });
    addPlayer(engine);
    spawnDummy(engine);
    // Step 0 lands 2 ticks after its press; recover so the next press is the 400 ms windup step.
    swing(engine);
    waitTicks(engine, 12);
    onSwingResolved.mockClear();
    return { engine, onSwingResolved };
  }

  it("commits the swing on the press and lands its damage at contact", () => {
    const { engine, onSwingResolved } = windupEngine();
    engine.beginDeltaFlush();
    const before = wolfHealth(engine);
    const pressTick = currentTick(engine);
    const press = swing(engine);
    expect(press).toMatchObject({ buffered: true, comboIndex: 1, hits: [] });
    expect(press.rejected).toBeUndefined();
    // The SWING event goes out on the press (other clients start the windup now).
    expect(swingEventIds(engine)).toEqual(["swing_1@test:slow"]);
    waitTicks(engine, 7);
    expect(wolfHealth(engine)).toBe(before);
    expect(onSwingResolved).not.toHaveBeenCalled();
    engine.tick();
    expect(currentTick(engine) - pressTick).toBe(8);
    expect(wolfHealth(engine)).toBeLessThan(before);
    expect(onSwingResolved).toHaveBeenCalledTimes(1);
    const result = onSwingResolved.mock.calls[0]![1] as SwingResolution;
    expect(result).toMatchObject({ seq: press.seq, comboIndex: 1 });
    expect(result.rejected).toBeUndefined();
    expect(result.hits.map((hit) => hit.entityId)).toEqual(["wolf"]);
    // Recovery counts from the press: 20 ticks of cadence, 8 already spent winding up.
    expect(result.nextSwingAtMs - 1_000_000 - currentTick(engine) * 50).toBe(12 * 50);
  });

  it("gates the next press on the step's full cadence", () => {
    const { engine } = windupEngine();
    swing(engine);
    waitTicks(engine, 20 - SWING_BUFFER_EARLY_TICKS - 1);
    expect(swing(engine).rejected).toBe("too_soon");
    waitTicks(engine, SWING_BUFFER_EARLY_TICKS + 1);
    const next = swing(engine);
    expect(next.rejected).toBeUndefined();
    expect(next.comboIndex).toBe(0);
  });

  it("a dash during the windup cancels the hit but keeps the combo step", () => {
    const { engine, onSwingResolved } = windupEngine();
    const before = wolfHealth(engine);
    swing(engine);
    waitTicks(engine, 2);
    engine.notePlayerDashed("p1");
    expect(onSwingResolved).toHaveBeenCalledTimes(1);
    const result = onSwingResolved.mock.calls[0]![1] as SwingResolution;
    expect(result).toMatchObject({ comboIndex: 1, hits: [] });
    expect(result.rejected).toBeUndefined();
    waitTicks(engine, 10);
    expect(wolfHealth(engine)).toBe(before);
    expect(onSwingResolved).toHaveBeenCalledTimes(1);
  });
});

describe("deferred sword swings deliver exactly one result, at contact", () => {
  /** A sword holder next to a dummy; `dashing` drives the engine's dash check. */
  function swordEngine() {
    const dash = { active: false };
    const resolved: SwingResolution[] = [];
    const engine = createEngine({
      isEntityDashing: () => dash.active,
      onSwingResolved: (_playerId, result) => resolved.push(result)
    });
    addPlayer(engine);
    spawnDummy(engine);
    equipWeapon(engine, "starter_sword");
    return { engine, dash, resolved };
  }

  it("a press mid-dash waits for the landing, then answers once with its hits after contact", () => {
    const { engine, dash, resolved } = swordEngine();
    const before = wolfHealth(engine);
    dash.active = true;
    const press = swing(engine);
    expect(press).toMatchObject({ buffered: true, hits: [] });
    waitTicks(engine, 3);
    expect(resolved).toEqual([]);
    dash.active = false;
    // The landing tick starts the swing (its windup); no placeholder result goes out.
    engine.tick();
    expect(resolved).toEqual([]);
    expect(wolfHealth(engine)).toBe(before);
    waitTicks(engine, 2);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ seq: press.seq, comboIndex: 0 });
    expect(resolved[0]!.buffered).toBeUndefined();
    expect(resolved[0]!.hits.map((hit) => hit.entityId)).toEqual(["wolf"]);
    expect(wolfHealth(engine)).toBeLessThan(before);
    waitTicks(engine, 20);
    expect(resolved).toHaveLength(1);
  });

  it("an early press answers once, after its own contact, with its hits", () => {
    const { engine, resolved } = swordEngine();
    const first = swing(engine);
    waitTicks(engine, 10 - SWING_BUFFER_EARLY_TICKS);
    const early = swing(engine);
    expect(early).toMatchObject({ buffered: true, hits: [] });
    waitTicks(engine, 30);
    expect(resolved.map((result) => result.seq)).toEqual([first.seq, early.seq]);
    for (const result of resolved) {
      expect(result.buffered).toBeUndefined();
      expect(result.hits.map((hit) => hit.entityId)).toEqual(["wolf"]);
    }
    expect(resolved[1]!.comboIndex).toBe(1);
  });

  it("a buffered press flushed by a new press answers once, at contact", () => {
    const { engine, dash, resolved } = swordEngine();
    dash.active = true;
    const held = swing(engine);
    dash.active = false;
    // The next press resolves the held one first (due now), then is itself too soon behind it.
    const next = swing(engine);
    expect(next.rejected).toBe("too_soon");
    expect(resolved).toEqual([]);
    waitTicks(engine, 2);
    expect(resolved.map((result) => [result.seq, result.hits.length])).toEqual([[held.seq, 1]]);
    waitTicks(engine, 20);
    expect(resolved).toHaveLength(1);
  });
});

describe("a windup cancels instead of landing when the swing changed before contact", () => {
  function pressed(onSwingResolved = vi.fn()) {
    const engine = createEngine({ onSwingResolved });
    addPlayer(engine);
    spawnDummy(engine);
    equipWeapon(engine, "starter_sword");
    const before = wolfHealth(engine);
    const press = swing(engine);
    expect(press.buffered).toBe(true);
    return { engine, onSwingResolved, before, press };
  }

  function expectCancelled(engine: CombatEngine, onSwingResolved: ReturnType<typeof vi.fn>, before: number) {
    waitTicks(engine, 4);
    expect(wolfHealth(engine)).toBe(before);
    expect(onSwingResolved).toHaveBeenCalledTimes(1);
    const result = onSwingResolved.mock.calls[0]![1] as SwingResolution;
    expect(result.hits).toEqual([]);
    expect(result.rejected).toBeUndefined();
  }

  it("lands normally when nothing changed", () => {
    const { engine, onSwingResolved, before } = pressed();
    waitTicks(engine, 4);
    expect(wolfHealth(engine)).toBeLessThan(before);
    expect((onSwingResolved.mock.calls[0]![1] as SwingResolution).hits).toHaveLength(1);
  });

  it("a weapon swap (another sword instance) during the windup", () => {
    const { engine, onSwingResolved, before } = pressed();
    equipWeapon(engine, "god_sword");
    expectCancelled(engine, onSwingResolved, before);
  });

  it("a weapon family swap (new combat style) during the windup", () => {
    const { engine, onSwingResolved, before } = pressed();
    equipWeapon(engine, "training_axe");
    expectCancelled(engine, onSwingResolved, before);
  });

  it("a zone or region change during the windup", () => {
    for (const change of [{ regionCode: "NM", zoneId: "world:NM:other" }, { regionCode: "interior:run-9", zoneId: "interior:run-9:room_1" }]) {
      const { engine, onSwingResolved, before } = pressed();
      engine.syncPlayer({ playerId: "p1", position: origin, ...change });
      expectCancelled(engine, onSwingResolved, before);
    }
  });
});

