import { describe, expect, it } from "vitest";

import {
  destinationPoint,
  distanceMeters,
  isMobSignatureAbilityId,
  MOB_ARCH_PHASE1_CEILING_HE_PER_SEC,
  MOB_ARCH_SIGNATURE_CEILING_MULTIPLIER,
  MOB_MELEE_WINDUP_ID,
  MOB_RANGED_AIM_ID,
  MOB_SIGNATURES,
  type CombatEvent,
  type LatLon
} from "@ash-atlas/shared";
import { zoneIdForPosition } from "../spatialZones.js";
import { CombatEngine } from "./combatEngine.js";

/**
 * Mob AI Phase 2 engine wiring (docs/plans/mob-ai-phase2.md chunks C to E): action combat, mob tactics and
 * MOB_ARCHETYPES_ENABLED on, 20 Hz with a manual clock, like combatEngine.mobTactics.test.ts.
 */

const origin = { lat: 35.0844, lon: -106.6504 };
const HZ = 20;
const PLAYER_SPEED_MPS = 125;
const ATTACK = 1_000;

type Special = {
  pendingBasicStrike: { targetEntityId: string } | null;
  pendingSignature: { kind: string; part: number } | null;
  staggerUntilTick: number;
  backstabUntilTick: number;
  archSignatureReadyTick: number;
  hitstunUntilTick: number;
};

type Entity = {
  entityId: string;
  position: LatLon;
  homePosition: LatLon;
  currentHealth: number;
  maxHealth: number;
  attackDamage: number;
  attackRangeM: number;
  leashRadiusM: number;
  challengeTier: string | null;
  targetEntityId: string | null;
  special?: Special;
};

type ArchState = {
  archetype: string;
  inSignature: boolean;
  retreatUntilTick: number;
  hopUntilTick: number;
  hopReadyTick: number;
  reachOverrideM: number | null;
};

type TacticsState = { phase: string; pool: string; cost: number; arch: ArchState | null; distanceM: number };

type Cast = {
  sourceEntityId: string;
  cast: { abilityId: string; castInstanceId: string; startTime: number; resolveTime: number; geometry: { kind: string; center?: LatLon; origin?: LatLon; radiusM?: number; lengthM?: number; widthM?: number; facingDegrees?: number } };
};

type EngineInternals = {
  entities: Map<string, Entity>;
  mobCasts: Cast[];
  currentTick: number;
  mobTactics: {
    mobs: Map<string, TacticsState>;
    ledgers: Map<string, { holds(id: string): boolean; inUse(pool: string): number; signatureHolderId: string | null }>;
  };
  setTarget(entity: Entity, targetEntityId: string): void;
  engageHostileMob(mob: Entity, player: Entity, session: unknown): void;
  ensurePveSession(player: Entity): unknown;
  triggerSkirmisherHops(player: Entity, dirX: number, dirY: number, ids: Iterable<string>): void;
  defeat(target: Entity, sourceEntityId: string): void;
  despawnMob(entityId: string): void;
};

function internals(engine: CombatEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

function at(distanceM: number, bearing: number, from: LatLon = origin): LatLon {
  return destinationPoint(from, distanceM, bearing);
}

type Options = { archetypes?: boolean; dodge?: () => boolean; only?: string };

function createEngine(options: Options = {}): CombatEngine {
  let clock = 1_000_000;
  const engine = new CombatEngine({
    tickRateHz: HZ,
    playerMovementSpeedMps: PLAYER_SPEED_MPS,
    isPlayerAuthorityActive: () => true,
    actionCombatEnabled: () => true,
    mobTacticsEnabled: () => true,
    mobArchetypesEnabled: () => options.archetypes ?? true,
    mobArchetypesOnly: () => options.only ?? "",
    isEntityInvulnerable: (entityId) => entityId === "p1" && (options.dodge?.() ?? false),
    repositionPlayer: () => true,
    random: () => 0.5,
    now: () => clock
  });
  const tick = engine.tick.bind(engine);
  engine.tick = () => {
    clock += 1_000 / HZ;
    tick();
  };
  return engine;
}

function addPlayer(engine: CombatEngine, playerId = "p1", position: LatLon = origin): Entity {
  engine.connectPlayer({
    // Overworld zone of the spot, the zone spawned and moving mobs are filed under (hits need the same zone).
    playerId, name: playerId, regionCode: "NM", zoneId: zoneIdForPosition(position), position,
    accountId: `account-${playerId}`, connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth: 100, baseAttackDamage: 1 }
  });
  const player = internals(engine).entities.get(playerId)!;
  player.maxHealth = 1_000_000_000;
  player.currentHealth = 1_000_000_000;
  return player;
}

function spawn(engine: CombatEngine, entityId: string, archetype: string, position: LatLon): Entity {
  engine.spawnMob({ entityId, archetype: archetype as never, position, regionCode: "NM", zoneId: zoneIdForPosition(position) });
  const mob = internals(engine).entities.get(entityId)!;
  mob.currentHealth = 1_000_000;
  mob.maxHealth = 1_000_000;
  mob.attackDamage = ATTACK;
  // No home leash: these tests place mobs where their signature triggers, far from any spawn rule.
  mob.leashRadiusM = 0;
  return mob;
}

function engage(engine: CombatEngine, mobId: string, playerId = "p1"): void {
  const engineInternals = internals(engine);
  const player = engineInternals.entities.get(playerId)!;
  const session = engineInternals.ensurePveSession(player) as { lastMeaningfulEngagementAtMs: number };
  engineInternals.engageHostileMob(engineInternals.entities.get(mobId)!, player, session);
  session.lastMeaningfulEngagementAtMs = Number.POSITIVE_INFINITY;
}

type CastRecord = { tick: number; mobId: string; abilityId: string; cast: Cast["cast"] };
type Recorder = {
  casts: CastRecord[];
  hits: { tick: number; mobId: string; amount: number }[];
  dodges: { tick: number; innateId: string }[];
  step(ticks?: number, each?: () => void): void;
  until(predicate: () => boolean, maxTicks?: number): number;
  signatures(): CastRecord[];
};

function record(engine: CombatEngine): Recorder {
  const seen = new Set<string>();
  engine.beginDeltaFlush();
  const tickOnce = (): void => {
    engine.tick();
    const tick = internals(engine).currentTick;
    for (const { cast, sourceEntityId } of internals(engine).mobCasts) {
      if (seen.has(cast.castInstanceId)) continue;
      seen.add(cast.castInstanceId);
      recorder.casts.push({ tick, mobId: sourceEntityId, abilityId: cast.abilityId, cast });
    }
    for (const event of engine.beginDeltaFlush().events as CombatEvent[]) {
      if (event.type === "DAMAGE" && event.targetEntityId === "p1" && (event.amount ?? 0) > 0 && event.sourceEntityId) {
        recorder.hits.push({ tick: event.tick, mobId: event.sourceEntityId, amount: event.amount ?? 0 });
      }
      if (event.type === "CLASS_INNATE_TRIGGERED" && event.innateId) recorder.dodges.push({ tick: event.tick, innateId: event.innateId });
    }
  };
  const recorder: Recorder = {
    casts: [], hits: [], dodges: [],
    step(ticks = 1, each) {
      for (let index = 0; index < ticks; index += 1) {
        tickOnce();
        each?.();
      }
    },
    until(predicate, maxTicks = 400) {
      for (let index = 0; index < maxTicks; index += 1) {
        tickOnce();
        if (predicate()) return internals(engine).currentTick;
      }
      throw new Error("condition not reached");
    },
    signatures() {
      return recorder.casts.filter((entry) => isMobSignatureAbilityId(entry.abilityId) && entry.abilityId !== "swarmer_wave");
    }
  };
  return recorder;
}

function state(engine: CombatEngine, mobId: string): TacticsState | undefined {
  return internals(engine).mobTactics.mobs.get(mobId);
}

function ledgerPoints(engine: CombatEngine): number {
  return engine.mobTacticsSnapshot().tokensInUse;
}

function distanceTo(engine: CombatEngine, mobId: string, playerId = "p1"): number {
  const entities = internals(engine).entities;
  return distanceMeters(entities.get(mobId)!.position, entities.get(playerId)!.position);
}

describe("mob archetypes: flag and join", () => {
  it("flag off: no archetype state, Phase 1 rhythm, legacy hog charge still fires", () => {
    const engine = createEngine({ archetypes: false });
    addPlayer(engine);
    spawn(engine, "hog", "hog", at(260, 90));
    engage(engine, "hog");
    expect(state(engine, "hog")?.arch).toBeNull();
    const recorder = record(engine);
    recorder.step(200);
    expect(recorder.casts.some((entry) => entry.abilityId === "hog_charge")).toBe(true);
    expect(recorder.casts.some((entry) => isMobSignatureAbilityId(entry.abilityId))).toBe(false);
  });

  it("flag on: archetype resolved at join; the rollout list filters; the caster reach override applies only under the flag", () => {
    const engine = createEngine({ only: "brute,caster" });
    addPlayer(engine);
    spawn(engine, "bear", "bear", at(110, 90));
    spawn(engine, "wolf", "wolf", at(110, 270));
    spawn(engine, "witch", "hedge_witch", at(230, 0));
    for (const id of ["bear", "wolf", "witch"]) engage(engine, id);
    expect(state(engine, "bear")?.arch?.archetype).toBe("brute");
    expect(state(engine, "wolf")?.arch).toBeNull();
    expect(state(engine, "witch")?.arch?.reachOverrideM).toBe(260);
    expect(state(engine, "witch")?.pool).toBe("ranged");
    const off = createEngine({ archetypes: false });
    addPlayer(off);
    spawn(off, "witch", "hedge_witch", at(230, 0));
    engage(off, "witch");
    expect(state(off, "witch")?.pool).toBe("melee");
  });

  it("turning the flag off mid-fight puts the mob back on Phase 1", () => {
    let on = true;
    let clock = 1_000_000;
    const engine = new CombatEngine({
      tickRateHz: HZ, playerMovementSpeedMps: PLAYER_SPEED_MPS, isPlayerAuthorityActive: () => true,
      actionCombatEnabled: () => true, mobTacticsEnabled: () => true, mobArchetypesEnabled: () => on,
      random: () => 0.5, now: () => (clock += 50)
    });
    addPlayer(engine);
    spawn(engine, "bear", "bear", at(110, 90));
    engage(engine, "bear");
    expect(state(engine, "bear")?.arch).not.toBeNull();
    on = false;
    engine.tick();
    expect(state(engine, "bear")?.arch).toBeNull();
  });
});

describe("mob archetypes: Brute", () => {
  it("charge: 1300 ms lane telegraph from 180 m+, hits, costs its point, then the token goes back", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "hog", "hog", at(300, 90));
    engage(engine, "hog");
    const recorder = record(engine);
    recorder.until(() => recorder.signatures().length > 0, 100);
    const charge = recorder.signatures()[0]!;
    expect(charge.abilityId).toBe("brute_charge");
    expect(charge.cast.geometry.kind).toBe("line");
    expect(charge.cast.resolveTime - charge.cast.startTime).toBe(MOB_SIGNATURES.charge.telegraphMs[0]);
    expect(ledgerPoints(engine)).toBe(1);
    expect(internals(engine).mobTactics.ledgers.get("p1")?.signatureHolderId).toBe("hog");
    recorder.step(MOB_SIGNATURES.charge.telegraphMs[0]! / 50 + 1);
    expect(recorder.hits.some((hit) => hit.mobId === "hog")).toBe(true);
    expect(internals(engine).mobTactics.ledgers.get("p1")?.signatureHolderId).toBeNull();
    // The mob ran through to the lane end, past the player.
    expect(distanceTo(engine, "hog")).toBeLessThan(150);
    recorder.step(20);
    expect(state(engine, "hog")?.phase).not.toBe("windup");
    expect(recorder.casts.some((entry) => entry.abilityId === "hog_charge")).toBe(false);
  });

  it("a dash at the resolve tick dodges the charge; the miss staggers 5 s and releases the token at once", () => {
    let dodging = false;
    const engine = createEngine({ dodge: () => dodging });
    addPlayer(engine);
    spawn(engine, "hog", "hog", at(300, 90));
    engage(engine, "hog");
    const recorder = record(engine);
    recorder.until(() => recorder.signatures().length > 0, 100);
    dodging = true;
    recorder.until(() => internals(engine).entities.get("hog")!.special!.pendingSignature === null, 40);
    dodging = false;
    const resolveTick = internals(engine).currentTick;
    expect(recorder.hits.filter((hit) => hit.mobId === "hog")).toHaveLength(0);
    expect(recorder.dodges.some((dodge) => dodge.innateId === "brute_charge")).toBe(true);
    expect(internals(engine).entities.get("hog")!.special!.staggerUntilTick).toBeGreaterThanOrEqual(resolveTick + 99);
    expect(ledgerPoints(engine)).toBe(0);
  });

  it("maul cone and slam circle hit tests, with knockback capped at 60 m", () => {
    for (const [archetype, abilityId, kind] of [["bear", "brute_maul", "cone"], ["ogre", "brute_slam", "circle"]] as const) {
      const engine = createEngine();
      const player = addPlayer(engine);
      spawn(engine, "brute", archetype, at(115, 90));
      engage(engine, "brute");
      const recorder = record(engine);
      recorder.until(() => recorder.signatures().length > 0, 300);
      const cast = recorder.signatures()[0]!;
      expect(cast.abilityId).toBe(abilityId);
      expect(cast.cast.geometry.kind).toBe(kind);
      const before = { ...player.position };
      recorder.until(() => internals(engine).entities.get("brute")!.special!.pendingSignature === null, 40);
      expect(recorder.hits.some((hit) => hit.mobId === "brute"), `${archetype}: ${JSON.stringify(recorder.dodges)} ${JSON.stringify(recorder.hits)}`).toBe(true);
      const pushed = distanceMeters(before, player.position);
      expect(pushed).toBeGreaterThan(30);
      expect(pushed).toBeLessThanOrEqual(60.5);
      expect(recorder.casts.some((entry) => entry.abilityId === `${archetype}_maul` || entry.abilityId === `${archetype}_slam`)).toBe(false);
    }
  });

  it("a brute signature keeps the pool within 2 points and no basic lands within 500 ms of it", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "bear", "bear", at(115, 90));
    for (let index = 0; index < 3; index += 1) spawn(engine, `wolf${index}`, "wolf", at(115, 180 + index * 60));
    for (const id of ["bear", "wolf0", "wolf1", "wolf2"]) engage(engine, id);
    const recorder = record(engine);
    const liveTicks = new Set<number>();
    recorder.step(600, () => {
      const bear = internals(engine).entities.get("bear")!;
      if (!bear.special?.pendingSignature) return;
      liveTicks.add(internals(engine).currentTick);
      expect(ledgerPoints(engine)).toBeLessThanOrEqual(2);
    });
    const mauls = recorder.casts.filter((entry) => entry.abilityId === "brute_maul");
    expect(mauls.length).toBeGreaterThan(0);
    const wolfStarts = recorder.casts.filter((entry) => entry.mobId.startsWith("wolf") && entry.abilityId === MOB_MELEE_WINDUP_ID);
    expect(wolfStarts.length).toBeGreaterThan(0);
    const maulLandings = mauls.map((entry) => entry.tick + 20);
    for (const hit of recorder.hits.filter((entry) => entry.mobId.startsWith("wolf"))) {
      for (const landing of maulLandings) expect(Math.abs(hit.tick - landing)).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("mob archetypes: Pack", () => {
  it("one lunge at a time, from behind or beside, 1200 ms; a miss staggers 1.5 s", () => {
    let dodging = false;
    const engine = createEngine({ dodge: () => dodging });
    addPlayer(engine);
    for (let index = 0; index < 4; index += 1) spawn(engine, `w${index}`, "wolf", at(170, index * 90));
    for (let index = 0; index < 4; index += 1) engage(engine, `w${index}`);
    const recorder = record(engine);
    let live = 0;
    recorder.step(400, () => {
      let now = 0;
      for (let index = 0; index < 4; index += 1) {
        if (internals(engine).entities.get(`w${index}`)!.special?.pendingSignature) now += 1;
      }
      live = Math.max(live, now);
    });
    const lunges = recorder.casts.filter((entry) => entry.abilityId === "pack_lunge");
    expect(lunges.length).toBeGreaterThan(0);
    expect(live).toBe(1);
    expect(lunges[0]!.cast.resolveTime - lunges[0]!.cast.startTime).toBe(MOB_SIGNATURES.lunge.telegraphMs[0]);
    // Dodge the next lunge: the wolf staggers 1.5 s.
    dodging = true;
    const before = recorder.casts.filter((entry) => entry.abilityId === "pack_lunge").length;
    recorder.until(() => recorder.casts.filter((entry) => entry.abilityId === "pack_lunge").length > before, 800);
    const lunge = recorder.casts.filter((entry) => entry.abilityId === "pack_lunge").at(-1)!;
    recorder.until(() => internals(engine).entities.get(lunge.mobId)!.special!.pendingSignature === null, 40);
    dodging = false;
    const stagger = internals(engine).entities.get(lunge.mobId)!.special!.staggerUntilTick - internals(engine).currentTick;
    expect(stagger).toBeGreaterThanOrEqual(29);
    expect(stagger).toBeLessThanOrEqual(30);
  });

  it("lunges start in the rear arc of a moving player", () => {
    const engine = createEngine();
    const player = addPlayer(engine);
    for (let index = 0; index < 4; index += 1) spawn(engine, `w${index}`, "wolf", at(170, index * 90));
    for (let index = 0; index < 4; index += 1) engage(engine, `w${index}`);
    const recorder = record(engine);
    // The player walks north slowly (heading 0): lunges must come from 100 degrees or more off north.
    recorder.step(400, () => {
      player.position = destinationPoint(player.position, 1.5, 0);
    });
    const lunges = recorder.casts.filter((entry) => entry.abilityId === "pack_lunge");
    expect(lunges.length).toBeGreaterThan(0);
    for (const lunge of lunges) {
      const facing = lunge.cast.geometry.facingDegrees!;
      // The lane points from the wolf to the player, so the wolf's bearing from the player is facing + 180.
      const bearingFromPlayer = (facing + 180) % 360;
      const off = Math.abs(((bearingFromPlayer - 0 + 540) % 360) - 180);
      expect(off).toBeGreaterThanOrEqual(99);
    }
  });

  it("hurt retreat: only with a living mate, one at a time; a lone wolf never retreats", () => {
    const engine = createEngine();
    addPlayer(engine);
    for (let index = 0; index < 3; index += 1) spawn(engine, `w${index}`, "wolf", at(170, index * 120));
    for (let index = 0; index < 3; index += 1) engage(engine, `w${index}`);
    for (let index = 0; index < 2; index += 1) {
      const wolf = internals(engine).entities.get(`w${index}`)!;
      wolf.currentHealth = wolf.maxHealth * 0.3;
    }
    const recorder = record(engine);
    let maxRetreating = 0;
    let retreatedOut = 0;
    recorder.step(60, () => {
      let count = 0;
      for (let index = 0; index < 3; index += 1) {
        const arch = state(engine, `w${index}`)?.arch;
        if (arch && arch.retreatUntilTick > internals(engine).currentTick) {
          count += 1;
          retreatedOut = Math.max(retreatedOut, distanceTo(engine, `w${index}`));
        }
      }
      maxRetreating = Math.max(maxRetreating, count);
    });
    expect(maxRetreating).toBe(1);
    expect(retreatedOut).toBeGreaterThan(200);
    const lone = createEngine();
    addPlayer(lone);
    spawn(lone, "w", "wolf", at(170, 0));
    engage(lone, "w");
    internals(lone).entities.get("w")!.currentHealth = 1;
    record(lone).step(100, () => {
      expect(state(lone, "w")?.arch?.retreatUntilTick ?? 0).toBeLessThanOrEqual(internals(lone).currentTick);
    });
  });
});

describe("mob archetypes: Skirmisher", () => {
  it("double strike: two cones in sequence, the second re-aimed at the moved player", () => {
    const engine = createEngine();
    const player = addPlayer(engine);
    spawn(engine, "spear", "mossjaw_spearman", at(115, 90));
    engage(engine, "spear");
    const recorder = record(engine);
    recorder.until(() => recorder.casts.some((entry) => entry.abilityId === "skirmisher_double_a"), 300);
    const first = recorder.casts.find((entry) => entry.abilityId === "skirmisher_double_a")!;
    expect(first.cast.resolveTime - first.cast.startTime).toBe(MOB_SIGNATURES.double_strike.telegraphMs[0]);
    // Sidestep 60 m north before the first cone lands.
    player.position = destinationPoint(player.position, 60, 0);
    recorder.until(() => recorder.casts.some((entry) => entry.abilityId === "skirmisher_double_b"), 40);
    const second = recorder.casts.find((entry) => entry.abilityId === "skirmisher_double_b")!;
    expect(second.tick - first.tick).toBe(MOB_SIGNATURES.double_strike.telegraphMs[0]! / 50);
    expect(second.cast.resolveTime - second.cast.startTime).toBe(MOB_SIGNATURES.double_strike.telegraphMs[1]);
    expect(Math.abs(((second.cast.geometry.facingDegrees! - first.cast.geometry.facingDegrees! + 540) % 360) - 180)).toBeGreaterThan(10);
    // The cones are 110 m / 70 degrees (telegraph time: 1200 + 1000 ms), so a 60 m sidestep may walk out of both.
    recorder.until(() => internals(engine).entities.get("spear")!.special!.pendingSignature === null, 40);
  });

  it("smoke step: a puff 60 m behind the player, the bandit blinks there and its next hit is primed", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "bandit", "bandit", at(300, 90));
    engage(engine, "bandit");
    const recorder = record(engine);
    recorder.until(() => recorder.signatures().length > 0, 200);
    const smoke = recorder.signatures()[0]!;
    expect(smoke.abilityId).toBe("skirmisher_smoke");
    expect(smoke.cast.geometry.kind).toBe("circle");
    const center = smoke.cast.geometry.center!;
    expect(distanceMeters(center, origin)).toBeCloseTo(MOB_SIGNATURES.smoke_step.rangeM, 0);
    recorder.until(() => internals(engine).entities.get("bandit")!.special!.pendingSignature === null, 40);
    const bandit = internals(engine).entities.get("bandit")!;
    expect(distanceMeters(bandit.position, center)).toBeLessThan(5);
    expect(bandit.special!.backstabUntilTick).toBeGreaterThan(internals(engine).currentTick);
  });

  it("owl swoop: the bird drops to swoop range for a 1300 ms cone instead of shooting", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "owl", "great_grey_owl", at(160, 90));
    engage(engine, "owl");
    const recorder = record(engine);
    recorder.until(() => recorder.signatures().length > 0, 300);
    const swoop = recorder.signatures()[0]!;
    expect(swoop.abilityId).toBe("skirmisher_swoop");
    expect(swoop.cast.resolveTime - swoop.cast.startTime).toBe(MOB_SIGNATURES.swoop.telegraphMs[0]);
    expect(distanceTo(engine, "owl")).toBeLessThanOrEqual(MOB_SIGNATURES.swoop.triggerMaxM + 1);
    expect(recorder.casts.filter((entry) => entry.abilityId === MOB_RANGED_AIM_ID && entry.tick < swoop.tick)).toHaveLength(0);
  });

  it("hop: out of reach when idle, at most once per 4 s, never during its own windup", () => {
    const engine = createEngine();
    const player = addPlayer(engine);
    spawn(engine, "spear", "mossjaw_spearman", at(115, 90));
    engage(engine, "spear");
    const recorder = record(engine);
    recorder.until(() => state(engine, "spear")?.phase === "windup", 300);
    internals(engine).triggerSkirmisherHops(player, 1, 0, ["spear"]);
    expect(state(engine, "spear")?.arch?.hopUntilTick ?? 0).toBeLessThanOrEqual(internals(engine).currentTick);
    recorder.until(() => state(engine, "spear")?.phase === "cooldown" || state(engine, "spear")?.phase === "wait", 100);
    const before = distanceTo(engine, "spear");
    internals(engine).triggerSkirmisherHops(player, 1, 0, ["spear"]);
    const arch = state(engine, "spear")!.arch!;
    expect(arch.hopUntilTick).toBeGreaterThan(internals(engine).currentTick);
    const trace: string[] = [];
    recorder.step(3, () => trace.push(`${state(engine, "spear")?.phase}:${distanceTo(engine, "spear").toFixed(0)}:${arch.hopUntilTick}:${internals(engine).currentTick}`));
    expect(distanceTo(engine, "spear"), trace.join(" ")).toBeGreaterThan(before + 80);
    const readyAt = arch.hopReadyTick;
    expect(readyAt - internals(engine).currentTick).toBeGreaterThan(70);
    internals(engine).triggerSkirmisherHops(player, 1, 0, ["spear"]);
    expect(arch.hopReadyTick).toBe(readyAt);
  });
});

describe("mob archetypes: Caster", () => {
  it("hedge witch holds 200-260 m and fires a ground blast circle locked on the player", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "witch", "hedge_witch", at(240, 0));
    engage(engine, "witch");
    const recorder = record(engine);
    recorder.until(() => recorder.signatures().length > 0, 300);
    const blast = recorder.signatures()[0]!;
    expect(blast.abilityId).toBe("caster_blast");
    expect(blast.cast.geometry.kind).toBe("circle");
    expect(distanceMeters(blast.cast.geometry.center!, origin)).toBeLessThan(5);
    recorder.step(200);
    const distance = distanceTo(engine, "witch");
    expect(distance).toBeGreaterThanOrEqual(190);
    expect(distance).toBeLessThanOrEqual(270);
    expect(recorder.casts.some((entry) => entry.abilityId === MOB_RANGED_AIM_ID && entry.mobId === "witch")).toBe(true);
  });

  it("kites back out when the player walks inside 150 m", () => {
    const engine = createEngine();
    const player = addPlayer(engine);
    spawn(engine, "witch", "hedge_witch", at(230, 0));
    engage(engine, "witch");
    const recorder = record(engine);
    recorder.step(40);
    player.position = destinationPoint(internals(engine).entities.get("witch")!.position, 100, 180);
    const close = distanceTo(engine, "witch");
    recorder.step(20);
    expect(distanceTo(engine, "witch")).toBeGreaterThan(close + 20);
  });

  it("volley: three distinct line telegraphs (left, centre, right), one hit at most", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "bow", "gnoll_bonebow", at(220, 0));
    engage(engine, "bow");
    const recorder = record(engine);
    recorder.until(() => recorder.signatures().length >= 3, 300);
    const lines = recorder.signatures().slice(0, 3);
    expect(lines.map((entry) => entry.abilityId).sort()).toEqual(["caster_volley_c", "caster_volley_l", "caster_volley_r"]);
    expect(new Set(lines.map((entry) => entry.cast.castInstanceId)).size).toBe(3);
    const hitsBefore = recorder.hits.filter((hit) => hit.mobId === "bow").length;
    recorder.until(() => internals(engine).entities.get("bow")!.special!.pendingSignature === null, 30);
    expect(recorder.hits.filter((hit) => hit.mobId === "bow").length - hitsBefore).toBe(1);
  });

  it("frog tongue: a lane from 120 m+, hit pulls the player in", () => {
    const engine = createEngine();
    const player = addPlayer(engine);
    spawn(engine, "frog", "frog", at(220, 90));
    engage(engine, "frog");
    const recorder = record(engine);
    recorder.until(() => recorder.signatures().length > 0, 300);
    expect(recorder.signatures()[0]!.abilityId).toBe("caster_tongue");
    const before = distanceTo(engine, "frog");
    recorder.until(() => internals(engine).entities.get("frog")!.special!.pendingSignature === null, 30);
    expect(recorder.hits.some((hit) => hit.mobId === "frog")).toBe(true);
    expect(distanceTo(engine, "frog")).toBeLessThan(before - 50);
    expect(player.position).toBeDefined();
    expect(recorder.casts.some((entry) => entry.abilityId === "frog_pull")).toBe(false);
  });
});

describe("mob archetypes: Swarmer", () => {
  it("waves of up to 4 land on one tick at 0.5 points each; with a bear the pool never exceeds 2", () => {
    const engine = createEngine();
    addPlayer(engine);
    for (let index = 0; index < 4; index += 1) spawn(engine, `s${index}`, "red_squirrel", at(90, index * 90));
    spawn(engine, "bear", "bear", at(115, 45));
    for (const id of ["s0", "s1", "s2", "s3", "bear"]) engage(engine, id);
    expect(state(engine, "s0")?.cost).toBe(0.5);
    const recorder = record(engine);
    let sharedTick = false;
    recorder.step(600, () => {
      expect(ledgerPoints(engine)).toBeLessThanOrEqual(2);
    });
    const waves = recorder.casts.filter((entry) => entry.abilityId === "swarmer_wave");
    expect(waves.length).toBeGreaterThan(4);
    const byTick = new Map<number, number>();
    for (const wave of waves) byTick.set(wave.tick, (byTick.get(wave.tick) ?? 0) + 1);
    for (const count of byTick.values()) {
      expect(count).toBeLessThanOrEqual(4);
      if (count > 1) sharedTick = true;
    }
    expect(sharedTick).toBe(true);
    expect(recorder.casts.some((entry) => entry.abilityId === MOB_MELEE_WINDUP_ID && entry.mobId.startsWith("s"))).toBe(false);
  });
});

describe("mob archetypes: shared rules", () => {
  it("one signature live per player and 1600 ms between signature landings, in a mixed fight", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "bear", "bear", at(115, 90));
    spawn(engine, "ogre", "ogre", at(115, 270));
    spawn(engine, "hog", "hog", at(300, 0));
    for (let index = 0; index < 3; index += 1) spawn(engine, `w${index}`, "wolf", at(170, 120 + index * 60));
    const ids = ["bear", "ogre", "hog", "w0", "w1", "w2"];
    for (const id of ids) engage(engine, id);
    const recorder = record(engine);
    const landings: number[] = [];
    recorder.step(1_200, () => {
      let live = 0;
      for (const id of ids) {
        const special = internals(engine).entities.get(id)!.special;
        if (special?.pendingSignature) live += 1;
        // Never a basic windup and a signature at once on one mob.
        expect(Boolean(special?.pendingSignature && special.pendingBasicStrike)).toBe(false);
      }
      expect(live).toBeLessThanOrEqual(1);
    });
    for (const entry of recorder.signatures()) {
      if (entry.abilityId === "skirmisher_double_b") continue;
      landings.push(entry.tick + Math.ceil((entry.cast.resolveTime - entry.cast.startTime) / 50));
    }
    landings.sort((left, right) => left - right);
    expect(landings.length).toBeGreaterThan(3);
    for (let index = 1; index < landings.length; index += 1) expect(landings[index]! - landings[index - 1]!).toBeGreaterThanOrEqual(32);
  });

  it("a target swap mid-signature cancels the telegraph and frees the slot; killing the mob empties the ledger", () => {
    const engine = createEngine();
    addPlayer(engine);
    addPlayer(engine, "p2", at(400, 180));
    spawn(engine, "bear", "bear", at(115, 90));
    engage(engine, "bear");
    const recorder = record(engine);
    recorder.until(() => internals(engine).entities.get("bear")!.special?.pendingSignature != null, 300);
    const bear = internals(engine).entities.get("bear")!;
    internals(engine).setTarget(bear, "p2");
    expect(bear.special!.pendingSignature).toBeNull();
    expect(internals(engine).mobCasts.some((entry) => entry.sourceEntityId === "bear" && isMobSignatureAbilityId(entry.cast.abilityId))).toBe(false);
    expect(internals(engine).mobTactics.ledgers.get("p1")?.signatureHolderId ?? null).toBeNull();
    expect(bear.special!.archSignatureReadyTick).toBeGreaterThanOrEqual(internals(engine).currentTick + 29);
    internals(engine).defeat(bear, "p2");
    recorder.step(2);
    expect(engine.mobTacticsSnapshot().tokensInUse).toBe(0);
  });

  it("a hit that kills the player mid double strike ends the move: no second cone, nothing left in the ledger", () => {
    const engine = createEngine();
    const player = addPlayer(engine);
    spawn(engine, "spear", "mossjaw_spearman", at(115, 90));
    engage(engine, "spear");
    const recorder = record(engine);
    recorder.until(() => recorder.casts.some((entry) => entry.abilityId === "skirmisher_double_a"), 300);
    player.currentHealth = 1;
    recorder.step(MOB_SIGNATURES.double_strike.telegraphMs[0]! / 50 + 3);
    expect(player.currentHealth <= 0 || (player as { lifeState?: string }).lifeState !== "alive").toBe(true);
    expect(recorder.casts.some((entry) => entry.abilityId === "skirmisher_double_b")).toBe(false);
    expect(internals(engine).entities.get("spear")!.special!.pendingSignature).toBeNull();
    expect(engine.mobTacticsSnapshot().tokensInUse).toBe(0);
  });

  it("a mob removed mid-signature takes its telegraph with it", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "bear", "bear", at(115, 90));
    engage(engine, "bear");
    const recorder = record(engine);
    recorder.until(() => internals(engine).entities.get("bear")!.special?.pendingSignature != null, 300);
    internals(engine).despawnMob("bear");
    recorder.step(2);
    expect(internals(engine).mobCasts.some((entry) => entry.sourceEntityId === "bear" && isMobSignatureAbilityId(entry.cast.abilityId))).toBe(false);
    expect(engine.mobTacticsSnapshot().managed).toBe(0);
  });

  it("guardrails: incoming HE/s per pack stays under the signature ceiling over 60 simulated seconds", () => {
    const packs: Array<[string, string[]]> = [
      ["brute", ["bear", "bear", "ogre", "hog"]],
      ["pack", ["wolf", "wolf", "wolf", "wolf"]],
      ["skirmisher", ["mossjaw_spearman", "mossjaw_spearman", "bandit", "bandit"]],
      ["swarmer", Array.from({ length: 8 }, () => "red_squirrel")],
      ["mixed", ["bear", "wolf", "wolf", "mossjaw_spearman", "red_squirrel", "red_squirrel", "hedge_witch"]]
    ];
    const ceiling = MOB_ARCH_PHASE1_CEILING_HE_PER_SEC * MOB_ARCH_SIGNATURE_CEILING_MULTIPLIER;
    for (const [name, roster] of packs) {
      const engine = createEngine();
      addPlayer(engine);
      roster.forEach((archetype, index) => spawn(engine, `m${index}`, archetype, at(archetype === "hedge_witch" ? 230 : 150, (index * 360) / roster.length)));
      roster.forEach((_, index) => engage(engine, `m${index}`));
      const recorder = record(engine);
      // Landed hit-equivalents as the ledger books them (basic factor or signature factor per landed hit),
      // summed over back-to-back 2 s governor windows.
      let he = 0;
      let worstWindow = 0;
      recorder.step(60 * HZ, () => {
        if (internals(engine).currentTick % (2 * HZ) !== 0) return;
        const load = engine.mobArchetypeLedgerSnapshot("p1")?.governorLoad ?? 0;
        he += load;
        worstWindow = Math.max(worstWindow, load);
      });
      const rate = he / 60;
      expect(worstWindow, `${name}: worst 2 s window ${worstWindow.toFixed(2)} HE`).toBeLessThanOrEqual(2 * ceiling);
      expect(rate, `${name}: ${rate.toFixed(2)} HE/s`).toBeLessThanOrEqual(ceiling);
      expect(rate, `${name} attacks at all`).toBeGreaterThan(0.2);
      expect(engine.mobTacticsSnapshot().tokensInUse).toBeLessThanOrEqual(3);
    }
  });
});
