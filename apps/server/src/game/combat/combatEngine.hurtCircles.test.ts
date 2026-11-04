import { describe, expect, it, vi } from "vitest";

import {
  destinationPoint,
  MOB_MELEE_WINDUP_RANGE_SLACK_M,
  MOB_RANGED_AIM_WIDTH_M,
  MOB_SIGNATURES,
  PLAYER_HURT_RADIUS_M,
  SHOT_RANGE_M,
  SWING_RANGE_M,
  mobHurtRadiusM,
  type LatLon,
  type MobSignatureParams
} from "@ash-atlas/shared";
import { CombatEngine } from "./combatEngine.js";
import { BEAR_MAUL, GOBLIN_BOMB, OGRE_SLAM, SWOOP } from "./mobGimmicks.js";
import { HOG_CHARGE } from "./mobSpecialBehaviors.js";
import { createSwingTargetScratch, selectShotTarget, selectSwingTargets, type SwingCandidateSample } from "./swingResolver.js";

/**
 * Hurt circles (docs/plans/hurt-circles.md): every server hit test against a combatant is "attack shape overlaps the
 * ground hurt circle". Each attack type: a body whose circle just overlaps the shape edge is hit, one just past it is
 * missed, and the effective (centre) reach stays what it was.
 */

const ZONE = "world:NM";
const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const r = PLAYER_HURT_RADIUS_M;
/** Bearing from the mob to the player: straight east. */
const EAST = 90;

type Entity = { position: LatLon; currentHealth: number; maxHealth: number; attackRangeM: number; zoneId: string };
type Engine = CombatEngine & {
  entities: Map<string, Entity>;
  currentTick: number;
  swingAttacker: unknown;
  swingSampleTick: number;
  readSwingCandidate(id: string, out: SwingCandidateSample): boolean;
  mobSpecial(mob: Entity): Record<string, unknown>;
  beginMeleeWindup(mob: Entity, target: Entity, dueTick: number, durationMs?: number, reachM?: number, archetype?: object): void;
  beginRangedAim(mob: Entity, target: Entity, dueTick: number, durationMs?: number, reachM?: number): void;
  resolvePendingMeleeStrike(mob: Entity, target: Entity): boolean;
  applySignatureHits(mob: Entity, target: Entity, pending: object, signature: MobSignatureParams, factor: number): number;
  resolveGimmickStrike(mob: Entity): void;
  processStag(mob: Entity, profile: typeof HOG_CHARGE): void;
};

function createEngine(): Engine {
  let clock = 1_000_000;
  const engine = new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    actionCombatEnabled: () => true,
    random: () => 0.5,
    now: () => clock
  });
  const tick = engine.tick.bind(engine);
  engine.tick = () => {
    clock += 50;
    tick();
  };
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: "NM", zoneId: ZONE, position: origin,
    accountId: "account-p1", connectionId: "connection-p1",
    profile: { playerId: "p1", maxHealth: 100, currentHealth: 100, baseAttackDamage: 1 }
  });
  engine.spawnMob({ entityId: "mob", archetype: "wolf", position: origin, regionCode: "NM", zoneId: ZONE });
  const internals = engine as unknown as Engine;
  for (const id of ["p1", "mob"]) {
    internals.entities.get(id)!.maxHealth = 1_000_000;
    internals.entities.get(id)!.currentHealth = 1_000_000;
  }
  return internals;
}

/** Puts the player at `distanceM` on `bearing` from the mob (the shape origin). */
function placePlayer(engine: Engine, distanceM: number, bearing = EAST): void {
  engine.syncPlayer({ playerId: "p1", regionCode: "NM", zoneId: ZONE, position: destinationPoint(origin, distanceM, bearing) });
}

function parts(engine: Engine): { mob: Entity; player: Entity } {
  return { mob: engine.entities.get("mob")!, player: engine.entities.get("p1")! };
}

/** Bearing off the east facing at which a circle at `distanceM` exactly touches a cone edge of half angle `halfDeg`. */
function edgeBearing(distanceM: number, halfDeg: number, radiusM: number): number {
  return EAST + halfDeg + (Math.asin(radiusM / distanceM) * 180) / Math.PI;
}

describe("hurt circles: basic mob strikes", () => {
  function strike(reachM: number | undefined, at: () => void, archetype?: object): boolean {
    const engine = createEngine();
    placePlayer(engine, 60);
    const { mob, player } = parts(engine);
    engine.beginMeleeWindup(mob, player, engine.currentTick, 450, reachM, archetype);
    at.call(null);
    return engine.resolvePendingMeleeStrike(mob, player);
  }

  it("unmanaged windup connects at attack range + slack (old reach) and misses just past it", () => {
    const probe = createEngine();
    const reach = parts(probe).mob.attackRangeM + MOB_MELEE_WINDUP_RANGE_SLACK_M;
    const run = (d: number, bearing = EAST) => {
      const engine = createEngine();
      placePlayer(engine, 60);
      const { mob, player } = parts(engine);
      engine.beginMeleeWindup(mob, player, engine.currentTick);
      placePlayer(engine, d, bearing);
      return engine.resolvePendingMeleeStrike(mob, player);
    };
    expect(run(reach - 0.5)).toBe(true);
    expect(run(reach + 0.5)).toBe(false);
    // Off the cone edge: the centre is outside the 90 degree wedge but the circle overlaps it.
    expect(run(50, edgeBearing(50, 45, r - 0.5))).toBe(true);
    expect(run(50, edgeBearing(50, 45, r + 0.5))).toBe(false);
  });

  it("managed melee connects at the 150 m effective reach (cone drawn 150 - r)", () => {
    const run = (d: number, archetype?: object) => {
      const engine = createEngine();
      placePlayer(engine, 60);
      const { mob, player } = parts(engine);
      engine.beginMeleeWindup(mob, player, engine.currentTick, 450, 150, archetype);
      placePlayer(engine, d);
      return engine.resolvePendingMeleeStrike(mob, player);
    };
    expect(run(149.5)).toBe(true);
    expect(run(150.5)).toBe(false);
    // The swarm wave (70 degree cone) measures the same way.
    const wave = { abilityId: MOB_SIGNATURES.pile_on_wave.abilityIds[0], angleDeg: MOB_SIGNATURES.pile_on_wave.angleDeg };
    expect(run(149.5, wave)).toBe(true);
    expect(run(150.5, wave)).toBe(false);
    expect(strike(150, () => undefined)).toBe(true);
  });

  it("ranged aim: the lane connects at its range and sideways while the circle overlaps the 40 m lane", () => {
    const run = (d: number, sideM = 0) => {
      const engine = createEngine();
      placePlayer(engine, 200);
      const { mob, player } = parts(engine);
      engine.beginRangedAim(mob, player, engine.currentTick, 900, 250);
      const ahead = destinationPoint(origin, d, EAST);
      engine.syncPlayer({ playerId: "p1", regionCode: "NM", zoneId: ZONE, position: destinationPoint(ahead, sideM, 0) });
      return engine.resolvePendingMeleeStrike(mob, player);
    };
    expect(run(249.5)).toBe(true);
    expect(run(250.5)).toBe(false);
    expect(run(150, MOB_RANGED_AIM_WIDTH_M / 2 + r - 0.5)).toBe(true);
    expect(run(150, MOB_RANGED_AIM_WIDTH_M / 2 + r + 0.5)).toBe(false);
  });
});

describe("hurt circles: signatures", () => {
  /** Effective reach straight ahead of each signature (the table value the AI triggers on). */
  const reachOf = (s: MobSignatureParams): number => (s.shape === "circle" ? s.radiusM : s.rangeM);
  const kinds = Object.values(MOB_SIGNATURES).filter((s) => s.kind !== "pile_on_wave") as MobSignatureParams[];

  function hits(signature: MobSignatureParams, distanceM: number, sideM = 0): number {
    const engine = createEngine();
    const { mob, player } = parts(engine);
    const pending = {
      kind: signature.kind, targetEntityId: "p1", part: 0, dueTick: engine.currentTick, origin: { ...origin },
      facingDegrees: EAST, lengthM: signature.rangeM, stopM: 0, anyHit: false
    };
    const ahead = destinationPoint(origin, distanceM, EAST);
    engine.syncPlayer({ playerId: "p1", regionCode: "NM", zoneId: ZONE, position: destinationPoint(ahead, sideM, 0) });
    return engine.applySignatureHits(mob, player, pending, signature, 1);
  }

  it.each(kinds.map((s) => [s.kind, s] as const))("%s connects at its table reach and misses just past it", (_kind, signature) => {
    const reach = reachOf(signature);
    expect(hits(signature, reach - 0.5)).toBe(1);
    expect(hits(signature, reach + 0.5)).toBe(0);
  });

  // (The volley fan is left out: its side lines sit beside the centre lane.)
  it.each(kinds.filter((s) => s.shape === "line").map((s) => [s.kind, s] as const))(
    "%s lane hits while the hurt circle overlaps its width",
    (_kind, signature) => {
      const along = Math.min(60, signature.rangeM / 2);
      expect(hits(signature, along, signature.widthM / 2 + r - 0.5)).toBe(1);
      expect(hits(signature, along, signature.widthM / 2 + r + 0.5)).toBe(0);
    }
  );
});

describe("hurt circles: legacy gimmick strikes and the legacy charge", () => {
  function gimmick(kind: string, distanceM: number, lengthM = 0): number {
    const engine = createEngine();
    const { mob } = parts(engine);
    const damage = vi.spyOn(engine as unknown as { applyScriptedDamage: () => void }, "applyScriptedDamage");
    Object.assign(engine.mobSpecial(mob), {
      strikeKind: kind, strikeCenter: { ...origin }, strikeTick: 0, strikeResolveAt: 0, strikeBearing: EAST,
      strikeLengthM: lengthM, strikeTargetId: "p1"
    });
    placePlayer(engine, distanceM);
    engine.resolveGimmickStrike(mob);
    return damage.mock.calls.filter((call) => (call as unknown[])[1] === "p1").length;
  }

  it.each([
    ["slam", OGRE_SLAM.radiusM],
    ["bomb", GOBLIN_BOMB.radiusM],
    ["maul", BEAR_MAUL.rangeM],
    ["swoop", SWOOP.rangeM]
  ] as const)("%s connects at its table reach and misses just past it", (kind, reach) => {
    expect(gimmick(kind, reach - 0.5)).toBe(1);
    expect(gimmick(kind, reach + 0.5)).toBe(0);
  });

  it("the legacy charge sweeps a capsule: same end reach as the sampled lane, no gaps between samples", () => {
    const lengthM = 300;
    const run = (d: number, sideM = 0) => {
      const engine = createEngine();
      const { mob } = parts(engine);
      const damage = vi.spyOn(engine as unknown as { applyScriptedDamage: () => void }, "applyScriptedDamage");
      Object.assign(engine.mobSpecial(mob), {
        chargeOrigin: { ...origin }, chargeBearing: EAST, chargeLengthM: lengthM, chargeHitTick: 0, chargeResolveAt: 0
      });
      const ahead = destinationPoint(origin, d, EAST);
      engine.syncPlayer({ playerId: "p1", regionCode: "NM", zoneId: ZONE, position: destinationPoint(ahead, sideM, 0) });
      engine.processStag(mob, HOG_CHARGE);
      return damage.mock.calls.filter((call) => (call as unknown[])[1] === "p1").length;
    };
    expect(run(lengthM + HOG_CHARGE.widthM - 0.5)).toBe(1);
    expect(run(lengthM + HOG_CHARGE.widthM + 0.5)).toBe(0);
    // Halfway between two old samples, at the capsule edge.
    const between = HOG_CHARGE.sampleStepM * 2.5;
    expect(run(between, HOG_CHARGE.widthM + r - 0.5)).toBe(1);
    expect(run(between, HOG_CHARGE.widthM + r + 0.5)).toBe(0);
  });
});

describe("hurt circles: player swings and shots use the mob's art-derived circle", () => {
  it("reads the wolf's hurt circle and connects at swing / shot range plus that radius", () => {
    const engine = createEngine();
    const sample = { lat: 0, lon: 0, radiusM: 0 };
    engine.swingAttacker = engine.entities.get("p1");
    engine.swingSampleTick = engine.currentTick;
    expect(engine.readSwingCandidate("mob", sample)).toBe(true);
    engine.swingAttacker = null;
    const rWolf = mobHurtRadiusM("wolf");
    expect(sample.radiusM).toBeCloseTo(rWolf, 9);
    const scratch = createSwingTargetScratch();
    const reader = (d: number) => (_id: string, out: SwingCandidateSample) => {
      const position = destinationPoint(origin, d, EAST);
      out.lat = position.lat;
      out.lon = position.lon;
      out.radiusM = rWolf;
      return true;
    };
    const swing = (d: number) => selectSwingTargets(origin.lat, origin.lon, 1, 0, ["mob"], reader(d), scratch);
    const shot = (d: number) => selectShotTarget(origin.lat, origin.lon, 1, 0, ["mob"], reader(d), scratch);
    expect(swing(SWING_RANGE_M + rWolf - 0.5)).toBe(1);
    expect(swing(SWING_RANGE_M + rWolf + 0.5)).toBe(0);
    expect(shot(SHOT_RANGE_M + rWolf - 0.5)).toBe(1);
    expect(shot(SHOT_RANGE_M + rWolf + 0.5)).toBe(0);
  });
});
