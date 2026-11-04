import { describe, expect, it, vi } from "vitest";
import { DUNGEON_CATALOG, distanceMeters, moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter } from "../bossFramework.js";
import { GRANDMASTER, GRANDMASTER_ABILITIES, GRANDMASTER_STANCES, createGrandmasterController, nextGrandmasterStance } from "../grandmasterBoss.js";
import { CombatEngine } from "./combatEngine.js";
import { MOB_DEFINITIONS } from "./mobDefinitions.js";
import {
  BELL_SPIRIT_TOLL,
  INITIATE_MONK_COMBO,
  IRON_STATUE,
  SHADOW_ACROBAT,
  STAFF_ADEPT_SWEEP,
  countAcrobatHit,
  countComboHit,
  newMonasteryMobState,
  shouldAwaken
} from "./monasteryBehaviors.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const at = (p: LatLon) => ({ lat: p.lat, lon: p.lon });
const REGION = "interior:monastery";
/** Room id `bell_hall` makes this a Monastery zone. */
const ZONE = "interior:run-1:bell_hall";

function createEngine(extra: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    isSharedMobCombat: () => true,
    isMobPlayerAttackAuthorized: () => true,
    ...extra
  });
}

function addPlayer(engine: CombatEngine, position: LatLon = origin, zoneId = ZONE): void {
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: REGION, zoneId, position,
    accountId: "a", connectionId: "c",
    profile: { playerId: "p1", maxHealth: 100_000, currentHealth: 100_000, baseAttackDamage: 20 }
  });
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, id: string, position: LatLon, zoneId = ZONE) {
  return engine.spawnMob({
    entityId: id, archetype, position, homePosition: position, regionCode: REGION, zoneId, worldAi: false
  });
}

const raw = (engine: CombatEngine, id: string) =>
  (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;
const tick = (engine: CombatEngine, count: number) => { for (let index = 0; index < count; index += 1) engine.tick(); };

describe("Monastery mob helpers", () => {
  it("the monk winds up its finisher after two landed hits", () => {
    const state = newMonasteryMobState();
    expect(countComboHit(state)).toBe(false);
    expect(countComboHit(state)).toBe(true);
    expect(state.comboHits).toBe(0);
  });

  it("the acrobat vanishes on every second hit", () => {
    const state = newMonasteryMobState();
    expect(countAcrobatHit(state)).toBe(false);
    expect(countAcrobatHit(state)).toBe(true);
    expect(countAcrobatHit(state)).toBe(false);
  });

  it("statues wake when a player is close or when struck", () => {
    const state = newMonasteryMobState();
    expect(shouldAwaken(state, null, false)).toBe(false);
    expect(shouldAwaken(state, IRON_STATUE.awakenRangeM + 1, false)).toBe(false);
    expect(shouldAwaken(state, IRON_STATUE.awakenRangeM - 1, false)).toBe(true);
    expect(shouldAwaken(state, null, true)).toBe(true);
    expect(IRON_STATUE.knockbackImmune).toBe(true);
  });

  it("Zephyr comes from the per-member Offering chest, not from the Grandmaster or his clones", () => {
    expect(MOB_DEFINITIONS.grandmaster.rewards.items).toEqual([]);
    const chest = DUNGEON_CATALOG.rewardTables.find((table) => table.id === "still_hand_monastery_sanctum_chest_reward");
    expect(chest?.items).toEqual([{ itemId: "zephyr", quantity: 1 }]);
    expect(MOB_DEFINITIONS.grandmaster.boss).toBe(true);
    expect(MOB_DEFINITIONS.grandmaster_clone.rewards.items).toEqual([]);
  });
});

describe("Monastery mobs in the combat engine", () => {
  it("a monk's third strike is telegraphed and knocks back", () => {
    const engine = createEngine({ repositionPlayer: () => true });
    addPlayer(engine);
    spawn(engine, "initiate_monk", "monk", east(60));
    expect(engine.directMobTarget("monk", "p1")).toBe(true);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    const knockback = vi.spyOn(engine, "knockbackPlayer");
    let windup = false;
    for (let index = 0; index < 200 && !windup; index += 1) {
      engine.tick();
      windup = raw(engine, "monk").monastery?.strikeKind === "finisher";
    }
    expect(windup).toBe(true);
    tick(engine, 30);
    expect(damage).toHaveBeenCalledWith("monk", "p1", expect.any(Number), INITIATE_MONK_COMBO.techniqueId);
    expect(knockback).toHaveBeenCalledWith("p1", expect.anything(), INITIATE_MONK_COMBO.knockbackM);
  });

  it("a staff adept sweeps around itself and then dashes onto its target", () => {
    const engine = createEngine({ repositionPlayer: () => true });
    addPlayer(engine);
    spawn(engine, "staff_adept", "adept", east(90));
    expect(engine.directMobTarget("adept", "p1")).toBe(true);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    tick(engine, Math.ceil((STAFF_ADEPT_SWEEP.firstDelayMs + STAFF_ADEPT_SWEEP.telegraphMs) / 50) + 10);
    expect(damage).toHaveBeenCalledWith("adept", "p1", expect.any(Number), STAFF_ADEPT_SWEEP.techniqueId);
    expect(distanceMeters(at(engine.entity("adept")!), origin)).toBeLessThanOrEqual(STAFF_ADEPT_SWEEP.dashStopM + 5);
  });

  it("a struck shadow acrobat reappears behind its target after two hits, and sometimes dodges", () => {
    const dodging = createEngine({ random: () => 0 });
    addPlayer(dodging);
    spawn(dodging, "shadow_acrobat", "acro", east(80));
    const full = dodging.entity("acro")!.currentHealth;
    dodging.applyScriptedDamage("p1", "acro", 10, "player_basic_attack");
    expect(dodging.entity("acro")!.currentHealth).toBeLessThanOrEqual(full);

    const engine = createEngine({ random: () => 0.99 });
    addPlayer(engine);
    spawn(engine, "shadow_acrobat", "acro", east(80));
    expect(engine.directMobTarget("acro", "p1")).toBe(true);
    engine.applyScriptedDamage("p1", "acro", 5, "test_hit");
    expect(raw(engine, "acro").monastery?.hitsTaken).toBe(1);
    engine.applyScriptedDamage("p1", "acro", 5, "test_hit");
    // Behind the player: on the far side from where it stood (east), so now west of the origin.
    expect(engine.entity("acro")!.lon).toBeLessThan(origin.lon);
    expect(distanceMeters(at(engine.entity("acro")!), origin)).toBeCloseTo(SHADOW_ACROBAT.behindM, -1);
  });

  it("an iron statue stays dormant until a player comes close, then slams", () => {
    const engine = createEngine({ repositionPlayer: () => true });
    addPlayer(engine, east(1_000));
    spawn(engine, "iron_statue", "statue", origin);
    tick(engine, 20);
    expect(raw(engine, "statue").monastery?.awake).toBe(false);
    raw(engine, "p1").position = east(IRON_STATUE.radiusM - 30);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    tick(engine, 2);
    expect(raw(engine, "statue").monastery?.awake).toBe(true);
    tick(engine, Math.ceil(IRON_STATUE.telegraphMs / 50) + 2);
    expect(damage).toHaveBeenCalledWith("statue", "p1", expect.any(Number), IRON_STATUE.techniqueId);
  });

  it("a bell spirit's toll silences general actives", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "bell_spirit", "bell", east(120));
    expect(engine.directMobTarget("bell", "p1")).toBe(true);
    tick(engine, Math.ceil((BELL_SPIRIT_TOLL.firstDelayMs + BELL_SPIRIT_TOLL.telegraphMs) / 50) + 5);
    const silenced = (engine as unknown as { silencedUntilTick: Map<string, number> }).silencedUntilTick.get("p1") ?? 0;
    expect(silenced).toBeGreaterThan((engine as unknown as { currentTick: number }).currentTick);
  });

  it("inside the Monastery weapons deal no damage; outside they do", () => {
    const inside = createEngine();
    addPlayer(inside);
    spawn(inside, "initiate_monk", "monk", east(60));
    raw(inside, "p1").classRuntime = { ...(raw(inside, "p1").classRuntime ?? {}), weaponCategory: "sword", effects: [], counters: {} };
    expect(inside.applyScriptedDamage("p1", "monk", 50, "player_basic_attack")).toBe(0);
    // Starting an attack with a weapon in hand is refused with a message instead of silently doing nothing.
    expect(() => inside.startAttack({ attackerId: "p1", targetEntityId: "monk", requestId: "armed", accountId: "a", connectionId: "c" }))
      .toThrow(expect.objectContaining({ code: "MONASTERY_UNARMED_ONLY" }));

    const outside = createEngine();
    addPlayer(outside, origin, "interior:run-1:heartwood");
    spawn(outside, "initiate_monk", "monk", east(60), "interior:run-1:heartwood");
    raw(outside, "p1").classRuntime = { ...(raw(outside, "p1").classRuntime ?? {}), weaponCategory: "sword", effects: [], counters: {} };
    expect(outside.applyScriptedDamage("p1", "monk", 50, "player_basic_attack")).toBeGreaterThan(0);
  });

  it("the Crane glow reflects damage back at the attacker", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "grandmaster", "gm", east(60));
    engine.setMobDamageReflect("gm", 1);
    const playerBefore = engine.entity("p1")!.currentHealth;
    expect(engine.applyScriptedDamage("p1", "gm", 40, "player_basic_attack")).toBe(0);
    expect(engine.entity("gm")!.currentHealth).toBe(engine.entity("gm")!.maxHealth);
    expect(engine.entity("p1")!.currentHealth).toBeLessThan(playerBefore);
    engine.setMobDamageReflect("gm", null);
    expect(engine.applyScriptedDamage("p1", "gm", 40, "player_basic_attack")).toBeGreaterThan(0);
  });

  it("the Crane glow does not reflect damage over time", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "grandmaster", "gm", east(60));
    engine.setMobDamageReflect("gm", 1);
    const playerBefore = engine.entity("p1")!.currentHealth;
    const internals = engine as unknown as { applyDamage(a: unknown, t: unknown, d: number, id: string, direct: boolean): number };
    internals.applyDamage(raw(engine, "p1"), raw(engine, "gm"), 40, "bleed_tick", false);
    expect(engine.entity("p1")!.currentHealth).toBe(playerBefore);
  });

  it("martial weapons still strike inside the Monastery", () => {
    for (const weaponCategory of ["brass_knuckles", "shuriken", "blowdart"]) {
      const engine = createEngine();
      addPlayer(engine);
      spawn(engine, "initiate_monk", "monk", east(60));
      raw(engine, "p1").classRuntime = { ...(raw(engine, "p1").classRuntime ?? {}), weaponCategory, effects: [], counters: {} };
      expect(engine.applyScriptedDamage("p1", "monk", 50, "player_basic_attack")).toBeGreaterThan(0);
    }
  });

  it("scripted leaps never move an iron statue", () => {
    const engine = createEngine();
    spawn(engine, "iron_statue", "statue", origin);
    spawn(engine, "initiate_monk", "monk", east(300));
    expect(engine.leapMobTo("statue", east(200))).toBe(false);
    expect(distanceMeters(at(engine.entity("statue")!), origin)).toBeLessThan(1);
  });
});

describe("The Grandmaster", () => {
  const definition = {
    id: "grandmaster", revision: 1, archetypeKey: "grandmaster" as const,
    controllerId: "grandmaster", rewardPolicy: { id: "grandmaster", minimumContribution: 1 }
  };
  function make(state: { ratio: number; reflect: (number | null)[] }, now: () => number) {
    return new BossEncounter({
      encounterId: "i:r:grandmaster:1:boss",
      definition,
      host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "grandmaster_sanctum", encounterId: "grandmaster:1:boss", participantIds: ["p1"] }),
      mobEntityId: "mob:gm",
      controller: createGrandmasterController({
        bossHealthRatio: () => state.ratio,
        bossPosition: () => east(300),
        playerPosition: () => origin,
        setReflect: (_id, fraction) => { state.reflect.push(fraction); }
      }),
      initialState: "active",
      now
    });
  }

  it("rotates Tiger and Crane, adding Mantis below half health", () => {
    expect(nextGrandmasterStance("tiger", false)).toBe("crane");
    expect(nextGrandmasterStance("crane", false)).toBe("tiger");
    expect(nextGrandmasterStance("crane", true)).toBe("mantis");
    expect(nextGrandmasterStance("mantis", true)).toBe("tiger");
  });

  it("throws telegraphed Tiger palms, then glows in Crane (reflecting) and calms between glows", () => {
    let now = 1_000;
    const state = { ratio: 1, reflect: [] as (number | null)[] };
    const encounter = make(state, () => now);
    encounter.activate();
    expect(encounter.phase).toBe(GRANDMASTER_STANCES.tiger);
    now += GRANDMASTER.firstStrikeDelayMs;
    encounter.tick(now);
    const palms = (encounter.projection(now).activeCasts ?? []).filter((cast) => cast.abilityId === GRANDMASTER_ABILITIES.tigerPalm);
    expect(palms).toHaveLength(1);
    expect(palms[0]!.geometry.kind).toBe("cone");

    now = 1_000 + GRANDMASTER.stanceMs;
    encounter.tick(now);
    expect(encounter.phase).toBe(GRANDMASTER_STANCES.crane);
    now += 50;
    encounter.tick(now);
    expect(encounter.phase).toBe(GRANDMASTER_STANCES.craneGlow);
    expect(state.reflect.at(-1)).toBe(GRANDMASTER.craneReflectFraction);
    now += GRANDMASTER.craneGlowMs;
    encounter.tick(now);
    expect(encounter.phase).toBe(GRANDMASTER_STANCES.crane);
    expect(state.reflect.at(-1)).toBeNull();

    state.ratio = 0.4;
    now = 1_000 + GRANDMASTER.stanceMs * 2;
    encounter.tick(now);
    expect(encounter.phase).toBe(GRANDMASTER_STANCES.mantis);
    expect(state.reflect.at(-1)).toBeNull();
  });
});
