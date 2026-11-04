import { describe, expect, it } from "vitest";

import {
  destinationPoint,
  MOB_MELEE_WINDUP_ID,
  MOB_MELEE_WINDUP_MS,
  MOB_MELEE_WINDUP_RANGE_SLACK_M,
  PLAYER_HURT_RADIUS_M,
  hurtShapeReachM,
  type CombatEvent,
  type LatLon
} from "@ash-atlas/shared";
import { CombatEngine } from "./combatEngine.js";

const origin = { lat: 35.0844, lon: -106.6504 };
const WINDUP_TICKS = MOB_MELEE_WINDUP_MS / 50;
/** Shared mob combat (raids and the like): the mob strikes through its own scheduled attack (resolveAttack). */
const SHARED = { isSharedMobCombat: () => true, isMobPlayerAttackAuthorized: () => true };

type EngineInternals = {
  entities: Map<string, {
    position: LatLon;
    currentHealth: number;
    maxHealth: number;
    attackRangeM: number;
    special?: { hitstunUntilTick: number; staggerUntilTick: number; pendingBasicStrike: unknown };
  }>;
  mobCasts: { cast: { abilityId: string; castInstanceId: string; geometry: { kind: string } } }[];
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
    random: () => 0.5,
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

function addPlayer(engine: CombatEngine, playerId = "p1", position: LatLon = origin): void {
  engine.connectPlayer({
    playerId,
    name: playerId,
    regionCode: "NM",
    zoneId: "world:NM",
    position,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth: 100, baseAttackDamage: 1 }
  });
  // Enough health to take every strike in a long run.
  const player = internals(engine).entities.get(playerId)!;
  player.maxHealth = 1_000_000;
  player.currentHealth = 1_000_000;
}

function spawnWolf(engine: CombatEngine, position: LatLon, attackRangeMOverride?: number): void {
  engine.spawnMob({
    entityId: "wolf", archetype: "wolf", position, regionCode: "NM", zoneId: "world:NM",
    ...(attackRangeMOverride === undefined ? {} : { attackRangeMOverride })
  });
  internals(engine).entities.get("wolf")!.currentHealth = 1_000_000;
  internals(engine).entities.get("wolf")!.maxHealth = 1_000_000;
}

type Recorder = {
  /** Ticks a melee windup telegraph started on. */
  windups: number[];
  /** Ticks of every wolf -> p1 DAMAGE event (hits and dodged zero-damage strikes). */
  strikes: { tick: number; amount: number }[];
  dodges: number[];
  log: string[];
  step(ticks?: number): void;
};

function record(engine: CombatEngine): Recorder {
  const seen = new Set<string>();
  engine.beginDeltaFlush();
  const recorder: Recorder = {
    windups: [], strikes: [], dodges: [], log: [],
    step(ticks = 1) {
      for (let index = 0; index < ticks; index += 1) {
        engine.tick();
        const tick = internals(engine).currentTick;
        for (const { cast } of internals(engine).mobCasts) {
          if (cast.abilityId !== MOB_MELEE_WINDUP_ID || seen.has(cast.castInstanceId)) continue;
          seen.add(cast.castInstanceId);
          recorder.windups.push(tick);
        }
        for (const event of engine.beginDeltaFlush().events as CombatEvent[]) {
          if (event.type === "DAMAGE" && event.sourceEntityId === "wolf" && event.targetEntityId === "p1") {
            recorder.strikes.push({ tick: event.tick, amount: event.amount ?? 0 });
          }
          if (event.type === "CLASS_INNATE_TRIGGERED" && event.innateId === MOB_MELEE_WINDUP_ID) recorder.dodges.push(event.tick);
          if (event.sourceEntityId === "wolf" || event.targetEntityId === "wolf" || event.targetEntityId === "p1") {
            recorder.log.push(`${event.tick} ${event.type} ${event.sourceEntityId ?? "-"}>${event.targetEntityId ?? "-"} ${event.amount ?? ""}`);
          }
        }
      }
    }
  };
  return recorder;
}

/** Steps until the first windup telegraph starts; returns its tick. */
function untilWindup(recorder: Recorder, maxTicks = 120): number {
  for (let index = 0; index < maxTicks && recorder.windups.length === 0; index += 1) recorder.step();
  expect(recorder.windups.length).toBeGreaterThan(0);
  return recorder.windups[0]!;
}

function directWolf(engine: CombatEngine): void {
  expect(engine.directMobTarget("wolf", "p1")).toBe(true);
}

function startSession(engine: CombatEngine): void {
  engine.startAttack({
    attackerId: "p1", targetEntityId: "wolf", requestId: "a1",
    accountId: "account-p1", connectionId: "connection-p1"
  });
}

function strikeTicks(recorder: Recorder): number[] {
  return recorder.strikes.map((strike) => strike.tick);
}

describe("action combat melee windup", () => {
  it("telegraphs a 90-degree cone and lands the strike 9 ticks later when the target stays in it", () => {
    const engine = createEngine(SHARED);
    addPlayer(engine);
    spawnWolf(engine, at(60, 90));
    const recorder = record(engine);
    directWolf(engine);
    const windupTick = untilWindup(recorder);
    const cast = internals(engine).mobCasts.find(({ cast: c }) => c.abilityId === MOB_MELEE_WINDUP_ID)!.cast;
    expect(cast.geometry).toMatchObject({ kind: "cone", angleDegrees: 90, rangeM: hurtShapeReachM(internals(engine).entities.get("wolf")!.attackRangeM + MOB_MELEE_WINDUP_RANGE_SLACK_M, PLAYER_HURT_RADIUS_M) });
    expect((cast.geometry as unknown as { facingDegrees: number }).facingDegrees).toBeCloseTo(270, 0);
    expect(recorder.strikes).toEqual([]);
    recorder.step(WINDUP_TICKS);
    expect(recorder.strikes).toHaveLength(1);
    expect(recorder.strikes[0]!.tick).toBe(windupTick + WINDUP_TICKS);
    expect(recorder.strikes[0]!.amount).toBeGreaterThan(0);
    expect(recorder.dodges).toEqual([]);
  });

  it("misses when the target leaves the cone: no damage, a DODGE event, no invented stagger", () => {
    const engine = createEngine(SHARED);
    addPlayer(engine);
    spawnWolf(engine, at(60, 90));
    const recorder = record(engine);
    directWolf(engine);
    const windupTick = untilWindup(recorder);
    engine.syncPlayer({ playerId: "p1", position: at(200, 270), regionCode: "NM", zoneId: "world:NM" });
    recorder.step(WINDUP_TICKS);
    expect(recorder.strikes).toEqual([{ tick: windupTick + WINDUP_TICKS, amount: 0 }]);
    expect(recorder.dodges).toEqual([windupTick + WINDUP_TICKS]);
    expect(internals(engine).entities.get("p1")!.currentHealth).toBe(1_000_000);
    expect(internals(engine).entities.get("wolf")!.special!.staggerUntilTick).toBe(0);
  });

  it("a dash out of the session view radius during the windup still resolves the strike as a DODGE", () => {
    for (const distanceM of [200, 5_000]) {
      const engine = createEngine();
      addPlayer(engine);
      spawnWolf(engine, at(60, 90));
      const recorder = record(engine);
      startSession(engine);
      const windupTick = untilWindup(recorder);
      engine.syncPlayer({ playerId: "p1", position: at(distanceM, 270), regionCode: "NM", zoneId: "world:NM" });
      recorder.step(WINDUP_TICKS + 2);
      expect(recorder.strikes, recorder.log.join(" | ")).toEqual([{ tick: windupTick + WINDUP_TICKS, amount: 0 }]);
      expect(recorder.dodges).toEqual([windupTick + WINDUP_TICKS]);
      expect(internals(engine).entities.get("p1")!.currentHealth).toBe(1_000_000);
      expect(internals(engine).entities.get("wolf")!.special!.pendingBasicStrike).toBeNull();
    }
  });

  it("is dodged by dash i-frames", () => {
    let dashing = false;
    const engine = createEngine({ ...SHARED, isEntityInvulnerable: (id) => dashing && id === "p1" });
    addPlayer(engine);
    spawnWolf(engine, at(60, 90));
    const recorder = record(engine);
    directWolf(engine);
    const windupTick = untilWindup(recorder);
    dashing = true;
    recorder.step(WINDUP_TICKS);
    expect(recorder.strikes).toEqual([{ tick: windupTick + WINDUP_TICKS, amount: 0 }]);
    expect(recorder.dodges).toEqual([windupTick + WINDUP_TICKS]);
  });

  it("hitstun during the windup delays the strike until it ends instead of cancelling it", () => {
    for (const path of ["direct", "session"] as const) {
      const engine = createEngine(path === "direct" ? SHARED : {});
      addPlayer(engine);
      spawnWolf(engine, at(60, 90));
      const recorder = record(engine);
      if (path === "direct") directWolf(engine);
      else startSession(engine);
      const windupTick = untilWindup(recorder);
      const wolf = internals(engine).entities.get("wolf")!;
      wolf.special!.hitstunUntilTick = windupTick + WINDUP_TICKS + 6;
      recorder.step(WINDUP_TICKS + 10);
      expect(strikeTicks(recorder)[0]).toBe(windupTick + WINDUP_TICKS + 6);
      expect(recorder.strikes[0]!.amount).toBeGreaterThan(0);
      // The same windup: no second telegraph before the delayed strike.
      expect(recorder.windups).toEqual([windupTick]);
    }
  });

  it("winds up in the session path (resolveEnemyOpportunity) and the strike lands on the turn", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawnWolf(engine, at(60, 90));
    const recorder = record(engine);
    startSession(engine);
    recorder.step(200);
    expect(recorder.windups.length).toBeGreaterThanOrEqual(5);
    // Every strike is preceded by its own windup exactly 9 ticks earlier.
    expect(strikeTicks(recorder).slice(0, 5)).toEqual(recorder.windups.slice(0, 5).map((tick) => tick + WINDUP_TICKS));
    expect(recorder.strikes.every((strike) => strike.amount > 0)).toBe(true);
  });

  it("keeps the 1.4 s cadence and the alternating phase over 10 beats in both paths", () => {
    for (const path of ["direct", "session"] as const) {
      const run = (flag: boolean): number[] => {
        const engine = createEngine({ ...(path === "direct" ? SHARED : {}), actionCombatEnabled: () => flag });
        addPlayer(engine);
        spawnWolf(engine, at(60, 90));
        const recorder = record(engine);
        if (path === "direct") directWolf(engine);
        else startSession(engine);
        recorder.step(28 * 12 + 20);
        return strikeTicks(recorder).slice(0, 10);
      };
      const off = run(false);
      const on = run(true);
      expect(off).toHaveLength(10);
      expect(on).toHaveLength(10);
      const gaps = on.slice(1).map((tick, index) => tick - on[index]!);
      expect(new Set(gaps)).toEqual(new Set(off.slice(1).map((tick, index) => tick - off[index]!)));
      if (path === "session") {
        // The windup eats into the half-beat before the strike: the strikes land on exactly the same ticks.
        expect(on).toEqual(off);
      } else {
        expect(gaps.every((gap) => gap === 28)).toBe(true);
      }
    }
  });

  it("leaves ranged mobs unchanged", () => {
    const run = (flag: boolean): { strikes: number[]; windups: number[] } => {
      const engine = createEngine({ ...SHARED, actionCombatEnabled: () => flag });
      addPlayer(engine);
      spawnWolf(engine, at(250, 90), 300);
      const recorder = record(engine);
      directWolf(engine);
      recorder.step(28 * 5);
      return { strikes: strikeTicks(recorder), windups: recorder.windups };
    };
    const on = run(true);
    expect(on.windups).toEqual([]);
    expect(on.strikes.length).toBeGreaterThanOrEqual(4);
    expect(on.strikes).toEqual(run(false).strikes);
  });

  it("with the flag off: no telegraphs and the pre-windup event sequence", () => {
    const log: string[] = [];
    for (const path of ["direct", "session"] as const) {
      const engine = createEngine({ ...(path === "direct" ? SHARED : {}), actionCombatEnabled: () => false });
      addPlayer(engine);
      spawnWolf(engine, at(60, 90));
      const recorder = record(engine);
      if (path === "direct") directWolf(engine);
      else startSession(engine);
      recorder.step(28 * 4);
      expect(recorder.windups).toEqual([]);
      expect(internals(engine).mobCasts).toEqual([]);
      log.push(`-- ${path}`, ...recorder.log);
    }
    expect(log).toMatchSnapshot();
  });
});
