import { describe, expect, it, vi } from "vitest";
import { MOB_RING_TELEGRAPH_ABILITY_IDS, distanceMeters, moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { CombatEngine } from "./combatEngine.js";
import {
  EMBER_SHADE_GRASP,
  EMBER_SHADE_WAIL,
  REVENANT_DOUBLE_STRIKE,
  REVENANT_FLANK_LUNGE,
  WARDEN_CHARGE,
  WARDEN_HEARTBEAT,
  WARDEN_SLAM,
  chooseWardenStrike,
  heartbeatContact,
  heartbeatFrontM,
  mayFlankLunge,
  newVaultMobState,
  vaultLaneLengthM
} from "./vaultBehaviors.js";

const origin: LatLon = { lat: 0.01, lon: 0.01 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const north = (m: number): LatLon => moveToward(origin, { lat: origin.lat + 0.02, lon: origin.lon }, m);
const south = (m: number): LatLon => moveToward(origin, { lat: origin.lat - 0.02, lon: origin.lon }, m);
const REGION = "interior:tilted_vault";
const ZONE = "interior:run-1:combat_c";

function createEngine(extra: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    isSharedMobCombat: () => true,
    isMobPlayerAttackAuthorized: () => true,
    repositionPlayer: () => true,
    ...extra
  });
}

function addPlayer(engine: CombatEngine, position: LatLon = origin): void {
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: REGION, zoneId: ZONE, position,
    accountId: "a", connectionId: "c",
    profile: { playerId: "p1", maxHealth: 1_000_000, currentHealth: 1_000_000, baseAttackDamage: 20 }
  });
}

function spawn(engine: CombatEngine, archetype: MobArchetypeKey, id: string, position: LatLon) {
  const mob = engine.spawnMob({ entityId: id, archetype, position, homePosition: position, regionCode: REGION, zoneId: ZONE, worldAi: false });
  expect(engine.directMobTarget(id, "p1")).toBe(true);
  return mob;
}

type Internals = { entities: Map<string, Record<string, any>>; currentTick: number; hurtRadiusM(entity: unknown): number };
const internals = (engine: CombatEngine) => engine as unknown as Internals;
const raw = (engine: CombatEngine, id: string) => internals(engine).entities.get(id)!;
const vault = (engine: CombatEngine, id: string) => raw(engine, id).vault as ReturnType<typeof newVaultMobState> | undefined;
const tick = (engine: CombatEngine, count: number) => { for (let index = 0; index < count; index += 1) engine.tick(); };
const tickUntil = (engine: CombatEngine, done: () => boolean, max = 600): boolean => {
  for (let index = 0; index < max; index += 1) {
    if (done()) return true;
    engine.tick();
  }
  return done();
};
const calledWith = (spy: { mock: { calls: readonly (readonly unknown[])[] } }, techniqueId: string): number =>
  spy.mock.calls.filter((call) => call[3] === techniqueId).length;

describe("Tilted Vault helpers", () => {
  it("only one Revenant lunges at a target at a time, and never the nearest one", () => {
    const far = { entityId: "far", distanceToTargetM: 220, lungeTargetId: null };
    const near = { entityId: "near", distanceToTargetM: 80, lungeTargetId: null };
    const mid = { entityId: "mid", distanceToTargetM: 180, lungeTargetId: null };
    expect(mayFlankLunge("near", "p1", [near, far, mid])).toBe(false);
    expect(mayFlankLunge("far", "p1", [near, far, mid])).toBe(true);
    expect(mayFlankLunge("far", "p1", [near, far, { ...mid, lungeTargetId: "p1" }])).toBe(false);
    // A lunge at someone else does not block this one; a lone Revenant is always the nearest.
    expect(mayFlankLunge("far", "p1", [near, far, { ...mid, lungeTargetId: "p2" }])).toBe(true);
    expect(mayFlankLunge("far", "p1", [far])).toBe(false);
  });

  it("the heartbeat front outruns walking and reports contact with a hurt circle", () => {
    expect(WARDEN_HEARTBEAT.speedMps).toBeGreaterThan(125 * 3);
    expect(heartbeatFrontM(1_000)).toBe(WARDEN_HEARTBEAT.speedMps);
    expect(heartbeatFrontM(1e9)).toBe(WARDEN_HEARTBEAT.maxRadiusM);
    expect(heartbeatContact(100, 300, 20)).toBe("ahead");
    expect(heartbeatContact(290, 300, 20)).toBe("touching");
    expect(heartbeatContact(330, 300, 20)).toBe("passed");
    expect(MOB_RING_TELEGRAPH_ABILITY_IDS.has(WARDEN_HEARTBEAT.techniqueId)).toBe(true);
  });

  it("the Warden alternates slam and charge, and charges when a slam is due but out of reach", () => {
    const state = newVaultMobState();
    expect(chooseWardenStrike(state, 50)).toBe("slam");
    expect(chooseWardenStrike(state, WARDEN_SLAM.triggerRangeM + 10)).toBe("charge");
    state.wardenNext = "charge";
    expect(chooseWardenStrike(state, 50)).toBe("charge");
    expect(vaultLaneLengthM(10, WARDEN_CHARGE)).toBe(WARDEN_CHARGE.minLengthM);
    expect(vaultLaneLengthM(10_000, WARDEN_CHARGE)).toBe(WARDEN_CHARGE.maxLengthM);
  });
});

describe("Tilted Vault mobs in the combat engine", () => {
  it("Ember Shade Grasp: a telegraphed cone that hits a player who stays, and misses one who steps aside", () => {
    for (const stepAside of [false, true]) {
      const engine = createEngine();
      addPlayer(engine);
      spawn(engine, "ember_shade", "gloom", east(80));
      const damage = vi.spyOn(engine, "applyScriptedDamage");
      expect(tickUntil(engine, () => vault(engine, "gloom")?.strikeKind === "grasp")).toBe(true);
      expect(engine.entity("gloom")!.telegraphs?.some((cast) => cast.abilityId === EMBER_SHADE_GRASP.techniqueId)).toBe(true);
      if (stepAside) raw(engine, "p1").position = north(400);
      tick(engine, Math.ceil(EMBER_SHADE_GRASP.telegraphMs / 50) + 2);
      expect(calledWith(damage, EMBER_SHADE_GRASP.techniqueId)).toBe(stepAside ? 0 : 1);
    }
  });

  it("Ember Wail: a 1.2 s circle, then the Shade takes no damage for 1 s and shows the ward", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "ember_shade", "gloom", east(80));
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    expect(tickUntil(engine, () => vault(engine, "gloom")?.strikeKind === "wail")).toBe(true);
    expect(EMBER_SHADE_WAIL.telegraphMs).toBe(1_200);
    const resolveTick = vault(engine, "gloom")!.strikeTick;
    expect(resolveTick - internals(engine).currentTick).toBe(24);
    tickUntil(engine, () => vault(engine, "gloom")?.strikeKind !== "wail");
    expect(calledWith(damage, EMBER_SHADE_WAIL.techniqueId)).toBe(1);
    const before = engine.entity("gloom")!.currentHealth;
    expect(engine.applyScriptedDamage("p1", "gloom", 50, "player_basic_attack")).toBe(0);
    expect(engine.entity("gloom")!.currentHealth).toBe(before);
    expect(engine.entity("gloom")!.mobBuffs?.some((buff) => buff.kind === "warded")).toBe(true);
    tick(engine, Math.ceil(EMBER_SHADE_WAIL.wardMs / 50) + 1);
    expect(engine.entity("gloom")!.mobBuffs?.some((buff) => buff.kind === "warded") ?? false).toBe(false);
    expect(engine.applyScriptedDamage("p1", "gloom", 50, "player_basic_attack")).toBeGreaterThan(0);
  });

  it("Ashbound Revenant double strike: the second cone follows right after the first", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "ashbound_revenant", "rev", east(80));
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    expect(tickUntil(engine, () => vault(engine, "rev")?.strikeKind === "double_a")).toBe(true);
    expect(tickUntil(engine, () => vault(engine, "rev")?.strikeKind === "double_b", 40)).toBe(true);
    expect(calledWith(damage, REVENANT_DOUBLE_STRIKE.techniqueIds[0])).toBe(1);
    tick(engine, Math.ceil(REVENANT_DOUBLE_STRIKE.telegraphMs[1] / 50) + 2);
    expect(calledWith(damage, REVENANT_DOUBLE_STRIKE.techniqueIds[1])).toBe(1);
    // A lone Revenant is the nearest one, so it never lunges.
    tick(engine, 300);
    expect(calledWith(damage, REVENANT_FLANK_LUNGE.techniqueId)).toBe(0);
  });

  it("Flank lunge: one Revenant per target at a time, never the nearest; the locked lane hits a player who stays", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "ashbound_revenant", "near", east(70));
    spawn(engine, "ashbound_revenant", "northRev", north(220));
    spawn(engine, "ashbound_revenant", "southRev", south(230));
    tick(engine, 1);
    const positions: Record<string, LatLon> = { near: east(70), northRev: north(220), southRev: south(230) };
    for (const [id, position] of Object.entries(positions)) {
      raw(engine, id).position = position;
      const state = vault(engine, id)!;
      state.nextSecondaryTick = internals(engine).currentTick;
      state.nextPrimaryTick = internals(engine).currentTick + 1_000;
      state.nextStrikeTick = 0;
    }
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    engine.tick();
    const lunging = Object.keys(positions).filter((id) => vault(engine, id)?.strikeKind === "lunge");
    expect(lunging).toHaveLength(1);
    expect(lunging[0]).not.toBe("near");
    const lane = engine.entity(lunging[0]!)!.telegraphs?.find((cast) => cast.abilityId === REVENANT_FLANK_LUNGE.techniqueId);
    expect(lane?.geometry.kind).toBe("line");
    raw(engine, "p1").position = origin;
    tick(engine, Math.ceil(REVENANT_FLANK_LUNGE.telegraphMs / 50) + 2);
    expect(calledWith(damage, REVENANT_FLANK_LUNGE.techniqueId)).toBe(1);
    // The lunger ends beside the player's locked spot.
    expect(distanceMeters(raw(engine, lunging[0]!).position, origin)).toBeLessThan(REVENANT_FLANK_LUNGE.overshootM + 20);
  });

  it("Vault Warden: slam then charge, each telegraphed and landing on a player who stays", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "vault_warden", "warden", east(100));
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    const kinds: string[] = [];
    for (let index = 0; index < 20 * 20; index += 1) {
      engine.tick();
      const kind = vault(engine, "warden")?.strikeKind ?? null;
      if (kind !== null && kinds[kinds.length - 1] !== kind) kinds.push(kind);
      raw(engine, "p1").position = origin;
    }
    expect(kinds.slice(0, 2)).toEqual(["slam", "charge"]);
    expect(calledWith(damage, WARDEN_SLAM.techniqueId)).toBeGreaterThan(0);
    expect(calledWith(damage, WARDEN_CHARGE.techniqueId)).toBeGreaterThan(0);
  });

  it("Heartbeat: the ember ring hits a player when its front reaches them, not before", () => {
    const engine = createEngine();
    const playerAt = east(700);
    addPlayer(engine, playerAt);
    spawn(engine, "vault_warden", "warden", origin);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    expect(tickUntil(engine, () => (vault(engine, "warden")?.heartbeatWindupTick ?? 0) > 0)).toBe(true);
    expect(engine.entity("warden")!.telegraphs?.some((cast) => cast.abilityId === WARDEN_HEARTBEAT.windupId)).toBe(true);
    expect(tickUntil(engine, () => vault(engine, "warden")?.pulse != null, 40)).toBe(true);
    const pulse = vault(engine, "warden")!.pulse!;
    expect(engine.entity("warden")!.telegraphs?.some((cast) => cast.abilityId === WARDEN_HEARTBEAT.techniqueId)).toBe(true);
    let hitTick = -1;
    for (let index = 0; index < 200 && hitTick < 0; index += 1) {
      raw(engine, "p1").position = playerAt;
      engine.tick();
      if (calledWith(damage, WARDEN_HEARTBEAT.techniqueId) > 0) hitTick = internals(engine).currentTick;
    }
    expect(hitTick).toBeGreaterThan(0);
    const r = internals(engine).hurtRadiusM(raw(engine, "p1"));
    const d = distanceMeters(playerAt, pulse.center);
    const elapsedMs = (hitTick - pulse.startTick) * 50;
    expect(heartbeatFrontM(elapsedMs)).toBeGreaterThanOrEqual(d - r);
    expect(heartbeatFrontM(elapsedMs - 50)).toBeLessThan(d - r);
  });

  it("Heartbeat: dash i-frames while the ring front passes dodge it, and it never lands late", () => {
    let dodging = false;
    const engine = createEngine({ isEntityInvulnerable: (id) => id === "p1" && dodging });
    const playerAt = east(700);
    addPlayer(engine, playerAt);
    spawn(engine, "vault_warden", "warden", origin);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    expect(tickUntil(engine, () => vault(engine, "warden")?.pulse != null)).toBe(true);
    const pulse = vault(engine, "warden")!.pulse!;
    const r = internals(engine).hurtRadiusM(raw(engine, "p1"));
    const d = distanceMeters(playerAt, pulse.center);
    let dodgedWindow = 0;
    for (let index = 0; index < 160; index += 1) {
      raw(engine, "p1").position = playerAt;
      // A 200 ms dash timed on the front: i-frames only while the front can touch the hurt circle.
      const front = heartbeatFrontM((internals(engine).currentTick + 1 - pulse.startTick) * 50);
      dodging = front >= d - r - 15 && front <= d + r + 15;
      if (dodging) dodgedWindow += 1;
      engine.tick();
    }
    // About the length of one dash's i-frames (200 ms = 4 beats) for the default hurt circle.
    expect(dodgedWindow).toBeLessThanOrEqual(Math.ceil((2 * r + 30) / (WARDEN_HEARTBEAT.speedMps / 20)) + 1);
    expect(calledWith(damage, WARDEN_HEARTBEAT.techniqueId)).toBe(0);
    expect(pulse.resolved.has("p1")).toBe(true);
  });
});
