import { describe, expect, it } from "vitest";

import {
  destinationPoint,
  distanceMeters,
  MOB_TACTICS_STARVATION_MS,
  mobTacticsBodyWidthM,
  mobTacticsSpacingM,
  circleVsCone,
  hurtShapeReachM,
  PLAYER_HURT_RADIUS_M,
  MOB_TACTICS_MELEE_REACH_M,
  MOB_TACTICS_MELEE_REACH_SLACK_M,
  mobTacticsEngageRadiusM,
  mobTacticsMeleeReachM,
  MOB_MELEE_WINDUP_ID,
  MOB_TACTICS_SLOT_ARRIVE_M,
  DASH_DISTANCE_M,
  MOB_RANGED_AIM_ID,
  MOB_RANGED_AIM_MS,
  MOB_TACTICS_MELEE_WINDUP_MS,
  MOB_TACTICS_RECOVER_MS,
  MOB_TACTICS_COOLDOWN_MIN_MS,
  type CombatEvent,
  type LatLon
} from "@ash-atlas/shared";
/** Effective centre-to-centre reach of a managed melee strike (150 m), the measure seats and cones are tuned on. */
const REACH_M = MOB_TACTICS_MELEE_REACH_M + MOB_TACTICS_MELEE_REACH_SLACK_M;
import { zoneIdForPosition } from "../spatialZones.js";
import { CombatEngine } from "./combatEngine.js";
import { MOB_DEFINITIONS } from "./mobDefinitions.js";
import { CAVE_RAPTOR_POUNCE } from "./mobSpecialBehaviors.js";

/** Telegraph time: managed melee windup and ranged aim in 20 Hz ticks (22 and 18). */
const WINDUP_TICKS = MOB_TACTICS_MELEE_WINDUP_MS / 50;
const AIM_TICKS = MOB_RANGED_AIM_MS / 50;
/** Phase 1 managed cycle: windup + recover + the cooldown floor (1650 ms = 33 ticks). */
const CYCLE_TICKS = (MOB_TACTICS_MELEE_WINDUP_MS + MOB_TACTICS_RECOVER_MS + MOB_TACTICS_COOLDOWN_MIN_MS) / 50;

/**
 * Mob tactics engine wiring (docs/plans/mob-ai-phase1.md, chunk 3): action combat on, the
 * MOB_TACTICS_ENABLED sub-flag on, 20 Hz with a manual clock, like combatEngine.meleeWindup.test.ts.
 */

const origin = { lat: 35.0844, lon: -106.6504 };
const LANDING_GAP_TICKS = 6;

type Entity = {
  position: LatLon;
  regionCode: string;
  currentHealth: number;
  maxHealth: number;
  attackRangeM: number;
  challengeTier: string | null;
  scheduledAttackTick: number | null;
  targetEntityId: string | null;
  special?: { pendingBasicStrike: { targetEntityId: string } | null; hitstunUntilTick: number; nextHopTick: number };
};

type EngineInternals = {
  entities: Map<string, Entity>;
  mobCasts: { sourceEntityId: string; cast: { abilityId: string; castInstanceId: string; geometry: { kind: string } } }[];
  currentTick: number;
  mobTactics: {
    mobs: Map<string, { phase: string; grabbed: boolean; waitingSinceTick: number; slotAngleDeg: number | null; radiusM: number }>;
    ledgers: Map<string, { holds(id: string): boolean }>;
  };
  grabMobTactics(mob: Entity, player: Entity): void;
  processRaptorFlank(mob: Entity, player: Entity): void;
  mobTacticsSlotPosition(mob: Entity, player: Entity): LatLon | null;
  positionHistory: { sampleCount(entityId: string): number };
  tacticsDestinationDistanceM(state: unknown, mob: Entity, radiusM: number, player: Entity, cosLat: number): number;
  defeat(target: Entity, sourceEntityId: string): void;
  setTarget(entity: Entity, targetEntityId: string): void;
  endPveSession(player: Entity, releaseAggro: boolean, reason?: string): void;
  engageHostileMob(mob: Entity, player: Entity, session: unknown): void;
  ensurePveSession(player: Entity): unknown;
};

function internals(engine: CombatEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

function at(distanceM: number, bearing: number, from: LatLon = origin): LatLon {
  return destinationPoint(from, distanceM, bearing);
}

function createEngine(tactics = true, overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}): CombatEngine {
  let clock = 1_000_000;
  const engine = new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    actionCombatEnabled: () => true,
    mobTacticsEnabled: () => tactics,
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
    // The overworld zone of the spot: spawned and moving mobs are filed under it, and strikes only land in-zone.
    zoneId: zoneIdForPosition(position),
    position,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth: 100, baseAttackDamage: 1 }
  });
  const player = internals(engine).entities.get(playerId)!;
  player.maxHealth = 1_000_000;
  player.currentHealth = 1_000_000;
}

function spawnWolf(engine: CombatEngine, entityId: string, position: LatLon, attackRangeMOverride?: number): Entity {
  engine.spawnMob({
    entityId, archetype: "wolf", position, regionCode: "NM", zoneId: zoneIdForPosition(position),
    ...(attackRangeMOverride === undefined ? {} : { attackRangeMOverride })
  });
  const wolf = internals(engine).entities.get(entityId)!;
  wolf.currentHealth = 1_000_000;
  wolf.maxHealth = 1_000_000;
  return wolf;
}

/** Engages a mob the way world-AI aggro and a landed opening attack do (engageHostileMob, a join hook). */
function engage(engine: CombatEngine, mobId: string, playerId = "p1"): void {
  const engineInternals = internals(engine);
  const player = engineInternals.entities.get(playerId)!;
  const session = engineInternals.ensurePveSession(player) as { lastMeaningfulEngagementAtMs: number };
  engineInternals.engageHostileMob(engineInternals.entities.get(mobId)!, player, session);
  // The player in these tests never swings; keep the 10 s abandonment timeout from ending the fight.
  session.lastMeaningfulEngagementAtMs = Number.POSITIVE_INFINITY;
}

/** Six wolves bunched 100-125 m east (the wolf leash is 160 m, so a pull from 300 m would disengage at once), engaged by p1. */
function spawnPack(engine: CombatEngine, count = 6): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `w${index}`;
    spawnWolf(engine, id, at(100 + index * 5, 85 + index * 2));
    ids.push(id);
  }
  for (const id of ids) engage(engine, id);
  return ids;
}

type Recorder = {
  windups: { tick: number; mobId: string; abilityId: string }[];
  strikes: { tick: number; mobId: string; amount: number }[];
  dodges: { tick: number; innateId: string }[];
  step(ticks?: number, each?: () => void): void;
};

function record(engine: CombatEngine): Recorder {
  const seen = new Set<string>();
  engine.beginDeltaFlush();
  const recorder: Recorder = {
    windups: [], strikes: [], dodges: [],
    step(ticks = 1, each) {
      for (let index = 0; index < ticks; index += 1) {
        engine.tick();
        const tick = internals(engine).currentTick;
        for (const { cast, sourceEntityId } of internals(engine).mobCasts) {
          if ((cast.abilityId !== MOB_MELEE_WINDUP_ID && cast.abilityId !== MOB_RANGED_AIM_ID) || seen.has(cast.castInstanceId)) continue;
          seen.add(cast.castInstanceId);
          recorder.windups.push({ tick, mobId: sourceEntityId, abilityId: cast.abilityId });
        }
        for (const event of engine.beginDeltaFlush().events as CombatEvent[]) {
          if (event.type === "DAMAGE" && event.targetEntityId === "p1" && event.sourceEntityId?.startsWith("w")) {
            recorder.strikes.push({ tick: event.tick, mobId: event.sourceEntityId, amount: event.amount ?? 0 });
          }
          if (event.type === "CLASS_INNATE_TRIGGERED" && (event.innateId === MOB_MELEE_WINDUP_ID || event.innateId === MOB_RANGED_AIM_ID)) {
            recorder.dodges.push({ tick: event.tick, innateId: event.innateId });
          }
        }
        each?.();
      }
    }
  };
  return recorder;
}

function minPairDistance(engine: CombatEngine, ids: readonly string[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      min = Math.min(min, distanceMeters(
        internals(engine).entities.get(ids[left]!)!.position,
        internals(engine).entities.get(ids[right]!)!.position
      ));
    }
  }
  return min;
}

/** Token points of the live windups this tick (epic and legendary cost 2). */
function liveWindupPoints(engine: CombatEngine, ids: readonly string[]): number {
  let points = 0;
  for (const id of ids) {
    const mob = internals(engine).entities.get(id);
    if (!mob?.special?.pendingBasicStrike) continue;
    points += mob.challengeTier === "epic" || mob.challengeTier === "legendary" ? 2 : 1;
  }
  return points;
}

function tacticsState(engine: CombatEngine) {
  return engine.mobTacticsSnapshot();
}

describe("mob tactics engine wiring", () => {
  it("spreads a 6-wolf pack around the player: no two wolves within 40 m once they arrive", () => {
    const engine = createEngine();
    addPlayer(engine);
    const ids = spawnPack(engine);
    expect(tacticsState(engine).managed).toBe(6);
    const recorder = record(engine);
    recorder.step(200);
    let closest = Number.POSITIVE_INFINITY;
    recorder.step(400, () => {
      closest = Math.min(closest, minPairDistance(engine, ids));
    });
    expect(closest).toBeGreaterThanOrEqual(40);
    for (const id of ids) {
      const distance = distanceMeters(internals(engine).entities.get(id)!.position, origin);
      expect(distance).toBeGreaterThan(50);
      expect(distance).toBeLessThan(200);
    }
    expect(recorder.windups.length).toBeGreaterThan(6);
  });

  it("control: with the sub-flag off the same pack stacks on the old queue path", () => {
    const engine = createEngine(false);
    addPlayer(engine);
    const ids = spawnPack(engine);
    expect(tacticsState(engine).managed).toBe(0);
    const recorder = record(engine);
    recorder.step(200);
    let closest = Number.POSITIVE_INFINITY;
    recorder.step(200, () => {
      closest = Math.min(closest, minPairDistance(engine, ids));
    });
    expect(closest).toBeLessThan(40);
  });

  it("keeps at most 2 token points of windups live; an epic costs 2", () => {
    for (const epic of [false, true]) {
      const engine = createEngine();
      addPlayer(engine);
      const ids: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const wolf = spawnWolf(engine, `w${index}`, at(100 + index * 5, 85 + index * 2));
        if (epic && index === 0) wolf.challengeTier = "epic";
        ids.push(`w${index}`);
      }
      for (const id of ids) engage(engine, id);
      const recorder = record(engine);
      let maxPoints = 0;
      let epicAlongside = false;
      recorder.step(600, () => {
        maxPoints = Math.max(maxPoints, liveWindupPoints(engine, ids));
        if (process.env.DBG_PTS && liveWindupPoints(engine, ids) > 2) console.log("DBG", internals(engine).currentTick, JSON.stringify(ids.map((id) => { const st = (internals(engine) as any).mobTactics.mobs.get(id); const sp = internals(engine).entities.get(id)!.special as any; return [id, st?.phase, sp?.pendingBasicStrike ? sp.pendingBasicStrike.dueTick : null, (internals(engine) as any).mobTactics.ledgers?.get?.("p1")?.holds?.(id)]; })));
        const live = ids.filter((id) => internals(engine).entities.get(id)!.special?.pendingBasicStrike);
        if (epic && live.includes("w0") && live.length > 1) epicAlongside = true;
        expect(tacticsState(engine).tokensInUse).toBeLessThanOrEqual(2);
      });
      expect(maxPoints).toBeLessThanOrEqual(2);
      expect(maxPoints).toBe(2);
      expect(epicAlongside).toBe(false);
      if (epic) expect(recorder.windups.some((windup) => windup.mobId === "w0")).toBe(true);
    }
  });

  it("lands strikes at least 300 ms apart and each windup strikes exactly once", () => {
    const engine = createEngine();
    addPlayer(engine);
    const ids = spawnPack(engine);
    const recorder = record(engine);
    recorder.step(800);
    const ticks = recorder.strikes.map((strike) => strike.tick).sort((left, right) => left - right);
    expect(ticks.length).toBeGreaterThan(10);
    for (let index = 1; index < ticks.length; index += 1) {
      expect(ticks[index]! - ticks[index - 1]!).toBeGreaterThanOrEqual(LANDING_GAP_TICKS);
    }
    // One DAMAGE (hit or dodged zero) per windup, per mob; the last windup may still be in flight.
    for (const id of ids) {
      const windups = recorder.windups.filter((windup) => windup.mobId === id).length;
      const strikes = recorder.strikes.filter((strike) => strike.mobId === id).length;
      expect(strikes === windups || strikes === windups - 1, `${id}: ${windups} windups, ${strikes} strikes`).toBe(true);
    }
  });

  it("directMobTarget on a managed mob does not add a second (scheduled) attacker", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawnWolf(engine, "w0", at(60, 90));
    engage(engine, "w0");
    expect(tacticsState(engine).managed).toBe(1);
    expect(engine.directMobTarget("w0", "p1")).toBe(true);
    expect(internals(engine).entities.get("w0")!.scheduledAttackTick).toBeNull();
    const recorder = record(engine);
    recorder.step(200);
    const windups = recorder.windups.length;
    expect(windups).toBeGreaterThan(3);
    expect(recorder.strikes.length).toBeGreaterThanOrEqual(windups - 1);
    expect(recorder.strikes.length).toBeLessThanOrEqual(windups);
  });

  it("a grabbed waiter takes the next free token ahead of longer waiters", () => {
    const engine = createEngine();
    addPlayer(engine);
    const ids = spawnPack(engine, 5);
    const recorder = record(engine);
    recorder.step(160);
    const engineInternals = internals(engine);
    const ledger = () => engineInternals.mobTactics.ledgers.get("p1")!;
    // Wait for a moment with both tokens held and at least two mobs waiting for one.
    let grabbedId: string | null = null;
    for (let index = 0; index < 200 && grabbedId === null; index += 1) {
      recorder.step();
      const waiting = ids.filter((id) => engineInternals.mobTactics.mobs.get(id)?.phase === "wait" && !ledger().holds(id));
      if (engine.mobTacticsSnapshot().tokensInUse === 2 && waiting.length >= 2) {
        // The newest waiter (least fair) is the one the player hits.
        grabbedId = [...waiting].sort((left, right) =>
          engineInternals.mobTactics.mobs.get(right)!.waitingSinceTick - engineInternals.mobTactics.mobs.get(left)!.waitingSinceTick)[0]!;
      }
    }
    expect(grabbedId).not.toBeNull();
    engineInternals.grabMobTactics(engineInternals.entities.get(grabbedId!)!, engineInternals.entities.get("p1")!);
    expect(engineInternals.mobTactics.mobs.get(grabbedId!)!.grabbed).toBe(true);
    const before = new Set(ids.filter((id) => ledger().holds(id)));
    let firstNewHolder: string | null = null;
    for (let index = 0; index < 60 && firstNewHolder === null; index += 1) {
      recorder.step();
      firstNewHolder = ids.find((id) => !before.has(id) && ledger().holds(id)) ?? null;
      for (const id of [...before]) if (!ledger().holds(id)) before.delete(id);
    }
    expect(firstNewHolder).toBe(grabbedId);
    expect(engine.mobTacticsSnapshot().tokensInUse).toBeLessThanOrEqual(2);
  });

  describe("leaves the ledger empty", () => {
    function holderMidWindup(): { engine: CombatEngine; recorder: Recorder } {
      const engine = createEngine();
      addPlayer(engine);
      spawnWolf(engine, "w0", at(60, 90));
      engage(engine, "w0");
      const recorder = record(engine);
      for (let index = 0; index < 200 && recorder.windups.length === 0; index += 1) recorder.step();
      expect(recorder.windups.length).toBe(1);
      expect(tacticsState(engine).tokensInUse).toBe(1);
      return { engine, recorder };
    }

    it("after the mob dies mid-windup", () => {
      const { engine, recorder } = holderMidWindup();
      internals(engine).defeat(internals(engine).entities.get("w0")!, "p1");
      expect(tacticsState(engine)).toEqual({ managed: 0, tokensInUse: 0, ledgers: 0 });
      recorder.step(20);
      expect(recorder.strikes).toEqual([]);
    });

    it("after a leash (the player runs far beyond the mob's home)", () => {
      const { engine, recorder } = holderMidWindup();
      engine.syncPlayer({ playerId: "p1", position: at(5_000, 270), regionCode: "NM", zoneId: zoneIdForPosition(at(5_000, 270)) });
      recorder.step(WINDUP_TICKS + 5);
      expect(tacticsState(engine)).toEqual({ managed: 0, tokensInUse: 0, ledgers: 0 });
      // The planted windup still resolved once, as a dodge.
      expect(recorder.strikes.map((strike) => strike.amount)).toEqual([0]);
    });

    it("after a dash out of range: the planted windup misses and the token comes back", () => {
      const { engine, recorder } = holderMidWindup();
      engine.syncPlayer({ playerId: "p1", position: at(400, 270), regionCode: "NM", zoneId: zoneIdForPosition(at(400, 270)) });
      recorder.step(WINDUP_TICKS + 1);
      expect(recorder.strikes.map((strike) => strike.amount)).toEqual([0]);
      expect(recorder.dodges.map((dodge) => dodge.innateId)).toEqual([MOB_MELEE_WINDUP_ID]);
      expect(tacticsState(engine).tokensInUse).toBe(0);
    });

    it("after a target swap: the windup is cancelled and the old ledger is gone", () => {
      const { engine, recorder } = holderMidWindup();
      addPlayer(engine, "p2", at(80, 180));
      internals(engine).setTarget(internals(engine).entities.get("w0")!, "p2");
      expect(internals(engine).entities.get("w0")!.special!.pendingBasicStrike).toBeNull();
      expect(internals(engine).mobTactics.ledgers.has("p1")).toBe(false);
      expect(tacticsState(engine).tokensInUse).toBe(0);
      expect(internals(engine).mobCasts.some(({ cast }) => cast.abilityId === MOB_MELEE_WINDUP_ID)).toBe(false);
      recorder.step(12);
      expect(recorder.strikes).toEqual([]);
    });

    it("after the session ends", () => {
      const { engine } = holderMidWindup();
      internals(engine).endPveSession(internals(engine).entities.get("p1")!, true, "cancelled");
      expect(tacticsState(engine)).toEqual({ managed: 0, tokensInUse: 0, ledgers: 0 });
    });
  });

  describe("ranged aim", () => {
    function aimingArcher(): { engine: CombatEngine; recorder: Recorder } {
      const engine = createEngine();
      addPlayer(engine);
      spawnWolf(engine, "w0", at(200, 90), 250);
      engage(engine, "w0");
      const recorder = record(engine);
      for (let index = 0; index < 200 && recorder.windups.length === 0; index += 1) recorder.step();
      expect(recorder.windups).toHaveLength(1);
      expect(recorder.windups[0]!.abilityId).toBe(MOB_RANGED_AIM_ID);
      const cast = internals(engine).mobCasts.find(({ cast: c }) => c.abilityId === MOB_RANGED_AIM_ID)!.cast;
      expect(cast.geometry).toMatchObject({ kind: "line", lengthM: hurtShapeReachM(250, PLAYER_HURT_RADIUS_M), widthM: 40 });
      return { engine, recorder };
    }

    it("lands when the target stays in the lane", () => {
      const { recorder } = aimingArcher();
      recorder.step(AIM_TICKS);
      expect(recorder.strikes).toHaveLength(1);
      expect(recorder.strikes[0]!.amount).toBeGreaterThan(0);
      expect(recorder.dodges).toEqual([]);
    });

    it("is dodged by stepping out of the lane: a DODGE plus a zero DAMAGE", () => {
      const { engine, recorder } = aimingArcher();
      engine.syncPlayer({ playerId: "p1", position: at(60, 0), regionCode: "NM", zoneId: zoneIdForPosition(at(60, 0)) });
      recorder.step(AIM_TICKS);
      expect(recorder.strikes.map((strike) => strike.amount)).toEqual([0]);
      expect(recorder.dodges.map((dodge) => dodge.innateId)).toEqual([MOB_RANGED_AIM_ID]);
      expect(internals(engine).entities.get("p1")!.currentHealth).toBe(1_000_000);
    });
  });

  describe("chunk 4", () => {
    function spawnRing(engine: CombatEngine, count: number, base = 100, step = 5): string[] {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        spawnWolf(engine, `w${index}`, at(base + index * step, 80 + index * 2));
        ids.push(`w${index}`);
      }
      for (const id of ids) engage(engine, id);
      return ids;
    }

    it("rotates engage seats by waiting time: every wolf of a 9-pack attacks without being grabbed", () => {
      const engine = createEngine();
      addPlayer(engine);
      const ids = spawnRing(engine, 9);
      const recorder = record(engine);
      recorder.step(800);
      for (const id of ids) {
        expect(recorder.windups.some((windup) => windup.mobId === id), `${id} never attacked`).toBe(true);
      }
    });

    it("spreads a pack across the reachable arc when its home is far from the player (leash-aware)", () => {
      const engine = createEngine();
      addPlayer(engine);
      const ids = spawnRing(engine, 6, 180, 8);
      const recorder = record(engine);
      recorder.step(240);
      // Only 2 engage seats fit on the reachable arc here, so seats rotate every cycle and mobs
      // cross between rings: brief close passes are expected, stacking is not.
      // Settled mobs (waiting at their slot) must be spread across the arc, not bunched at its edge.
      const engineInternals = internals(engine);
      const player = engineInternals.entities.get("p1")!;
      const cosLat = Math.cos((player.position.lat * Math.PI) / 180);
      let closest = Number.POSITIVE_INFINITY;
      let closestSettled = Number.POSITIVE_INFINITY;
      let settledSamples = 0;
      recorder.step(400, () => {
        closest = Math.min(closest, minPairDistance(engine, ids));
        const settled = ids.filter((id) => {
          const state = engineInternals.mobTactics.mobs.get(id)!;
          return (state.phase === "wait" || state.phase === "cooldown") &&
            engineInternals.tacticsDestinationDistanceM(state, engineInternals.entities.get(id)!, state.radiusM, player, cosLat) <= 15;
        });
        if (settled.length >= 2) {
          settledSamples += 1;
          closestSettled = Math.min(closestSettled, minPairDistance(engine, settled));
        }
      });
      expect(engine.mobTacticsSnapshot().managed).toBe(6);
      // Combat feel: mobs spend longer in their (walkable) windup, so fewer samples find two settled at once.
      expect(settledSamples).toBeGreaterThan(60);
      expect(closestSettled).toBeGreaterThanOrEqual(40);
      expect(closest).toBeGreaterThanOrEqual(15);
    });

    it("a lone mob attacks every 1650 ms +-10 percent (telegraph time: 1100 / 250 / 300)", () => {
      const engine = createEngine();
      addPlayer(engine);
      spawnWolf(engine, "w0", at(60, 90));
      engage(engine, "w0");
      const recorder = record(engine);
      recorder.step(600);
      const ticks = recorder.strikes.map((strike) => strike.tick);
      expect(ticks.length).toBeGreaterThan(15);
      const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]!);
      const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
      expect(mean).toBeGreaterThanOrEqual(CYCLE_TICKS * 0.9);
      expect(mean).toBeLessThanOrEqual(CYCLE_TICKS * 1.1);
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(CYCLE_TICKS - 2);
        expect(gap).toBeLessThanOrEqual(CYCLE_TICKS + 2);
      }
    });

    it("is fair: over 20 s every one of 6 wolves attacks and none waits past starvation plus a cycle", () => {
      const engine = createEngine();
      addPlayer(engine);
      const ids = spawnPack(engine);
      const recorder = record(engine);
      recorder.step(100);
      const from = internals(engine).currentTick;
      recorder.step(400);
      // Starvation plus a cycle, plus the walk in from the wait ring (one 118 m spacing at a wolf's 1.2 m per tick) and
      // the windup: with body-sized seats one of six wolves waits on the outer ring.
      const walkInTicks = Math.ceil(mobTacticsSpacingM(mobTacticsBodyWidthM("wolf")) / 1.2);
      // Plus slack for the seat swap itself: the 5-tick ring pass, the landing gap and the token holders finishing.
      // Telegraph time: a 1650 ms cycle plus one more token hold (1100 ms windup + 250 ms recover).
      const limitTicks = (MOB_TACTICS_STARVATION_MS + 1_650 + 1_350) / 50 + walkInTicks + 9 + 30;
      for (const id of ids) {
        const ticks = [from, ...recorder.windups.filter((windup) => windup.mobId === id && windup.tick > from).map((windup) => windup.tick)];
        expect(ticks.length, `${id} never attacked`).toBeGreaterThan(1);
        for (let index = 1; index < ticks.length; index += 1) expect(ticks[index]! - ticks[index - 1]!).toBeLessThanOrEqual(limitTicks);
      }
    });

    it("follows a circling player without teleports or slot churn", () => {
      const engine = createEngine();
      addPlayer(engine);
      const ids = spawnPack(engine);
      const recorder = record(engine);
      recorder.step(120);
      const last = new Map(ids.map((id) => [id, { ...internals(engine).entities.get(id)!.position }]));
      const lastSlot = new Map(ids.map((id) => [id, internals(engine).mobTactics.mobs.get(id)!.slotAngleDeg]));
      const slotJumps = new Map(ids.map((id) => [id, 0]));
      let maxJumpM = 0;
      for (let tick = 0; tick < 200; tick += 1) {
        const angle = (tick / 200) * 360;
        engine.syncPlayer({ playerId: "p1", position: at(50, angle), regionCode: "NM", zoneId: zoneIdForPosition(at(50, angle)) });
        recorder.step();
        for (const id of ids) {
          const position = internals(engine).entities.get(id)!.position;
          maxJumpM = Math.max(maxJumpM, distanceMeters(last.get(id)!, position));
          last.set(id, { ...position });
          const slot = internals(engine).mobTactics.mobs.get(id)?.slotAngleDeg ?? null;
          const previous = lastSlot.get(id) ?? null;
          if (slot !== null && previous !== null && Math.abs(((slot - previous + 540) % 360) - 180) > 5) {
            slotJumps.set(id, slotJumps.get(id)! + 1);
          }
          lastSlot.set(id, slot);
        }
      }
      expect(engine.mobTacticsSnapshot().managed).toBe(6);
      expect(maxJumpM).toBeLessThan(40);
      for (const id of ids) expect(slotJumps.get(id)!, id).toBeLessThanOrEqual(10);
    });

    it("hitstun during a windup defers the strike, keeps the token, and still strikes once", () => {
      const engine = createEngine();
      addPlayer(engine);
      spawnWolf(engine, "w0", at(60, 90));
      engage(engine, "w0");
      const recorder = record(engine);
      for (let index = 0; index < 200 && recorder.windups.length === 0; index += 1) recorder.step();
      const wolf = internals(engine).entities.get("w0")!;
      const hitstunEnd = internals(engine).currentTick + WINDUP_TICKS + 3;
      wolf.special!.hitstunUntilTick = hitstunEnd;
      recorder.step(WINDUP_TICKS + 1);
      expect(recorder.strikes).toEqual([]);
      expect(engine.mobTacticsSnapshot().tokensInUse).toBe(1);
      recorder.step(6);
      expect(recorder.strikes).toHaveLength(1);
      expect(recorder.strikes[0]!.tick).toBeGreaterThanOrEqual(hitstunEnd);
    });

    it("a managed cave raptor pounces to its tactics slot", () => {
      const engine = createEngine();
      addPlayer(engine);
      engine.spawnMob({ entityId: "r0", archetype: "cave_raptor", position: at(60, 90), regionCode: "NM", zoneId: zoneIdForPosition(at(60, 90)) });
      const raptor = internals(engine).entities.get("r0")!;
      raptor.currentHealth = raptor.maxHealth = 1_000_000;
      engage(engine, "r0");
      const recorder = record(engine);
      recorder.step(10);
      expect(engine.mobTacticsSnapshot().managed).toBe(1);
      const player = internals(engine).entities.get("p1")!;
      raptor.position = at(Math.max(CAVE_RAPTOR_POUNCE.minDistanceM, raptor.attackRangeM + 10) + 10, 90);
      raptor.special!.nextHopTick = 0;
      internals(engine).processRaptorFlank(raptor, player);
      const slot = internals(engine).mobTacticsSlotPosition(raptor, player);
      expect(slot).not.toBeNull();
      expect(distanceMeters(raptor.position, slot!)).toBeLessThan(1);
    });

    it("leaves bosses, shared-combat mobs, interior fights and non-player targets on the old path", () => {
      const bossArchetype = Object.entries(MOB_DEFINITIONS).find(([, definition]) => (definition as { boss?: boolean }).boss)?.[0];
      expect(bossArchetype).toBeDefined();
      const boss = createEngine();
      addPlayer(boss);
      boss.spawnMob({ entityId: "b0", archetype: bossArchetype as "wolf", position: at(60, 90), regionCode: "NM", zoneId: zoneIdForPosition(at(60, 90)) });
      engage(boss, "b0");
      expect(boss.mobTacticsSnapshot().managed).toBe(0);

      const shared = createEngine(true, { isSharedMobCombat: () => true });
      addPlayer(shared);
      spawnWolf(shared, "w0", at(60, 90));
      engage(shared, "w0");
      expect(shared.mobTacticsSnapshot().managed).toBe(0);

      const interior = createEngine();
      addPlayer(interior);
      spawnWolf(interior, "w0", at(60, 90));
      internals(interior).entities.get("p1")!.regionCode = "interior:test";
      internals(interior).entities.get("w0")!.regionCode = "interior:test";
      engage(interior, "w0");
      expect(interior.mobTacticsSnapshot().managed).toBe(0);

      const retarget = createEngine();
      addPlayer(retarget);
      spawnWolf(retarget, "w0", at(60, 90));
      spawnWolf(retarget, "w1", at(200, 0));
      engage(retarget, "w0");
      expect(retarget.mobTacticsSnapshot().managed).toBe(1);
      internals(retarget).setTarget(internals(retarget).entities.get("w0")!, "w1");
      expect(retarget.mobTacticsSnapshot()).toEqual({ managed: 0, tokensInUse: 0, ledgers: 0 });
    });

    it("records every tactics step in the lag-compensation history", () => {
      const engine = createEngine();
      addPlayer(engine);
      spawnWolf(engine, "w0", at(150, 90));
      engage(engine, "w0");
      const before = { ...internals(engine).entities.get("w0")!.position };
      const recorder = record(engine);
      recorder.step(10);
      expect(distanceMeters(before, internals(engine).entities.get("w0")!.position)).toBeGreaterThan(5);
      expect(internals(engine).positionHistory.sampleCount("w0")).toBeGreaterThanOrEqual(8);
    });

    it("caps the competing roster at 16 and keeps at most 2 tokens with 18 wolves", () => {
      const engine = createEngine();
      addPlayer(engine);
      spawnRing(engine, 18, 100, 2);
      const recorder = record(engine);
      recorder.step(300, () => {
        expect(engine.mobTacticsSnapshot().tokensInUse).toBeLessThanOrEqual(2);
      });
      expect(engine.metricsSnapshot().tacticsManaged).toBe(18);
      expect(recorder.windups.some((windup) => windup.mobId === "w16" || windup.mobId === "w17")).toBe(false);
      expect(new Set(recorder.windups.map((windup) => windup.mobId)).size).toBeGreaterThan(2);
    });

    it("maxTacticsPerTick round-robins targets so every fight still advances", () => {
      const engine = createEngine(true, { maxTacticsPerTick: 1 });
      addPlayer(engine);
      addPlayer(engine, "p2", at(3_000, 0));
      spawnWolf(engine, "w0", at(60, 90));
      spawnWolf(engine, "w1", at(60, 90, at(3_000, 0)));
      engage(engine, "w0");
      engage(engine, "w1", "p2");
      const recorder = record(engine);
      recorder.step(200);
      expect(engine.metricsSnapshot().tacticsManaged).toBe(2);
      expect(recorder.windups.some((windup) => windup.mobId === "w0")).toBe(true);
      expect(recorder.windups.some((windup) => windup.mobId === "w1")).toBe(true);
    });

    it("reports zero tactics metrics with the sub-flag off", () => {
      const engine = createEngine(false);
      addPlayer(engine);
      spawnPack(engine);
      record(engine).step(50);
      expect(engine.metricsSnapshot()).toMatchObject({ tacticsManaged: 0, tacticsTokensInUse: 0 });
    });
  });

  describe("sprite-sized spacing", () => {
    for (const count of [4, 8]) {
      it(`keeps a ${count}-wolf pack a body width plus gap apart and around the player, not in a crescent`, () => {
        const engine = createEngine();
        addPlayer(engine);
        const ids: string[] = [];
        for (let index = 0; index < count; index += 1) {
          spawnWolf(engine, `w${index}`, at(100 + index * 5, 85 + index * 2));
          ids.push(`w${index}`);
        }
        for (const id of ids) engage(engine, id);
        const recorder = record(engine);
        recorder.step(300);
        const spacing = mobTacticsSpacingM(mobTacticsBodyWidthM("wolf"));
        let closest = Number.POSITIVE_INFINITY;
        let widestGapDeg = 0;
        recorder.step(400, () => {
          closest = Math.min(closest, minPairDistance(engine, ids));
          const bearings = ids.map((id) => {
            const position = internals(engine).entities.get(id)!.position;
            const dx = (position.lon - origin.lon) * Math.cos((origin.lat * Math.PI) / 180);
            const dy = position.lat - origin.lat;
            return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
          }).sort((left, right) => left - right);
          let gap = 360 - bearings[bearings.length - 1]! + bearings[0]!;
          for (let index = 1; index < bearings.length; index += 1) gap = Math.max(gap, bearings[index]! - bearings[index - 1]!);
          widestGapDeg = Math.max(widestGapDeg, gap);
        });
        expect(engine.mobTacticsSnapshot().managed).toBe(count);
        // Firm minimum: waiters on a crowded band may pack to body width + 5 m, never closer than a body width
        // (sprites never drawn on top of each other); full spacing is the target, not the floor.
        const body = mobTacticsBodyWidthM("wolf");
        expect(closest, `closest ${closest.toFixed(1)} m vs body ${body.toFixed(1)} m, spacing ${spacing.toFixed(1)} m`).toBeGreaterThanOrEqual(body);
        // Surround: no empty arc wider than 180 degrees around the player (a crescent leaves one).
        expect(widestGapDeg).toBeLessThan(180);
      });
    }
  });

  describe("melee reach under tactics", () => {
    it("winds up a swing-reach cone from the engage ring (clear of the player sprite), and a full dash still clears it", () => {
      const engine = createEngine();
      addPlayer(engine);
      spawnWolf(engine, "w0", at(60, 90));
      engage(engine, "w0");
      const recorder = record(engine);
      for (let index = 0; index < 200 && recorder.windups.length === 0; index += 1) recorder.step();
      const cast = internals(engine).mobCasts.find(({ cast: c }) => c.abilityId === MOB_MELEE_WINDUP_ID)!.cast;
      // The cone is drawn the player's hurt radius short of the 150 m effective reach and hits the hurt circle.
      expect(cast.geometry).toMatchObject({ kind: "cone", rangeM: hurtShapeReachM(REACH_M, PLAYER_HURT_RADIUS_M) });
      const wolfDistance = distanceMeters(internals(engine).entities.get("w0")!.position, origin);
      // A holder inside its engage ring steps out to within the 10 m arrive tolerance before winding up.
      expect(wolfDistance).toBeGreaterThanOrEqual(mobTacticsEngageRadiusM(100, mobTacticsBodyWidthM("wolf")) - 12);
      expect(wolfDistance).toBeLessThanOrEqual(REACH_M);
      // Dash sideways (perpendicular to the strike) or straight away: both leave the cone.
      for (const bearing of [0, 270]) {
        expect(circleVsCone(270, hurtShapeReachM(REACH_M, PLAYER_HURT_RADIUS_M), 90, ...offsetFrom(wolfDistance, bearing), PLAYER_HURT_RADIUS_M)).toBe(false);
      }
    });
  });
});

/** Local (x east, y north) of the player after a full dash along `bearing`, seen from a wolf `distanceM` east of it. */
function offsetFrom(distanceM: number, bearing: number): [number, number] {
  const radians = (bearing * Math.PI) / 180;
  return [-distanceM + Math.sin(radians) * DASH_DISTANCE_M, Math.cos(radians) * DASH_DISTANCE_M];
}

describe("per-archetype body widths and wait bands", () => {
  it("derives body width from the sprite art: small mobs smaller than a wolf, reach always covers the engage ring", () => {
    const wolf = mobTacticsBodyWidthM("wolf");
    // Wolf art at ground zoom 15 and the world PNG master scale (0.8): about 76 m (95 m at master scale 1).
    expect(wolf).toBeGreaterThan(60);
    expect(wolf).toBeLessThan(105);
    // Widths come from the art, so they vary by archetype (smaller and bigger than a wolf).
    const widths = Object.keys(MOB_DEFINITIONS).map((archetype) =>
      mobTacticsBodyWidthM(archetype, (MOB_DEFINITIONS as Record<string, { spriteKey: string }>)[archetype]!.spriteKey));
    expect(Math.min(...widths)).toBeLessThan(wolf);
    expect(Math.max(...widths)).toBeGreaterThan(wolf);
    for (const archetype of Object.keys(MOB_DEFINITIONS)) {
      const definition = (MOB_DEFINITIONS as Record<string, { attackRangeM: number; spriteKey: string }>)[archetype]!;
      if (definition.attackRangeM > 100) continue;
      const engageRadius = mobTacticsEngageRadiusM(definition.attackRangeM, mobTacticsBodyWidthM(archetype, definition.spriteKey));
      // Combat feel: reach is the player's swing reach (edge measure); a seat on the clamped ring, within the arrive
      // tolerance, still strikes the player's centre.
      expect(mobTacticsMeleeReachM(definition.attackRangeM, engageRadius), archetype).toBe(MOB_TACTICS_MELEE_REACH_M);
      expect(engageRadius + MOB_TACTICS_SLOT_ARRIVE_M, archetype).toBeLessThanOrEqual(REACH_M);
    }
  });

  it("puts the first waiters on the 160 m band, one step from the 130 m swing reach, and a hit grabs them", () => {
    const engine = createEngine();
    addPlayer(engine);
    const ids: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      spawnWolf(engine, `w${index}`, at(100 + index * 5, 85 + index * 2));
      ids.push(`w${index}`);
    }
    for (const id of ids) engage(engine, id);
    const recorder = record(engine);
    recorder.step(300);
    const radii = ids.map((id) => Math.round((internals(engine).mobTactics.mobs.get(id) as unknown as { radiusM: number }).radiusM));
    // Band 0 sits at 160 m or just outside it (never inside the engage ring plus a packed body): a short step from
    // the swing reach (130 m to the target's edge, so about 150 m centre to centre).
    const band0 = (radius: number) => radius >= 160 && radius <= 165;
    expect(radii.filter(band0).length).toBeGreaterThan(0);
    expect(Math.max(...radii)).toBeLessThanOrEqual(205);
    const waiter = ids.find((id) => band0(Math.round((internals(engine).mobTactics.mobs.get(id) as unknown as { radiusM: number }).radiusM)) &&
      internals(engine).mobTactics.mobs.get(id)!.phase === "wait")!;
    expect(waiter).toBeDefined();
    internals(engine).grabMobTactics(internals(engine).entities.get(waiter)!, internals(engine).entities.get("p1")!);
    expect(internals(engine).mobTactics.mobs.get(waiter)!.grabbed).toBe(true);
  });
});
