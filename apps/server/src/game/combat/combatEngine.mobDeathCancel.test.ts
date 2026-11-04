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
 * Death cancels every pending mob action: windups, aims, signatures, tokens and telegraphs go with the mob.
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
const SCENARIOS: ReadonlyArray<{ name: string; archetype: string; distanceM: number; bearing?: number; ready?: (mob: Entity) => boolean }> = [
  { name: "melee windup", archetype: "red_squirrel", distanceM: 60, ready: (mob) => mob.special?.pendingBasicStrike != null },
  { name: "ranged aim", archetype: "gnoll_bonebow", distanceM: 220, bearing: 0 },
  { name: "charge", archetype: "hog", distanceM: 300 },
  { name: "maul", archetype: "bear", distanceM: 115 },
  { name: "slam", archetype: "ogre", distanceM: 115 },
  { name: "double strike (first cone)", archetype: "mossjaw_spearman", distanceM: 115 },
  { name: "smoke step", archetype: "bandit", distanceM: 300 },
  { name: "swoop", archetype: "great_grey_owl", distanceM: 160 },
  { name: "ground blast", archetype: "hedge_witch", distanceM: 240, bearing: 0 },
  { name: "tongue", archetype: "frog", distanceM: 220 }
];

function liveAction(mob: Entity): boolean {
  return mob.special?.pendingSignature != null || mob.special?.pendingBasicStrike != null;
}

describe("mob death cancels pending actions", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: a mob killed mid-telegraph deals no damage and leaves nothing behind`, () => {
      const engine = createEngine();
      addPlayer(engine);
      spawn(engine, "m", scenario.archetype, at(scenario.distanceM, scenario.bearing ?? 90));
      engage(engine, "m");
      const recorder = record(engine);
      const mob = internals(engine).entities.get("m")!;
      recorder.until(() => (scenario.ready ? scenario.ready(mob) : liveAction(mob)) && internals(engine).mobCasts.some((c) => c.sourceEntityId === "m"), 400);
      expect(internals(engine).mobCasts.some((c) => c.sourceEntityId === "m")).toBe(true);
      const hitsBefore = recorder.hits.length;
      internals(engine).defeat(mob, "p1");
      // Cleared at once, not only after the telegraph would have expired.
      expect(internals(engine).mobCasts.some((c) => c.sourceEntityId === "m")).toBe(false);
      expect(mob.special?.pendingSignature ?? null).toBeNull();
      expect(mob.special?.pendingBasicStrike ?? null).toBeNull();
      expect(engine.mobTacticsSnapshot().tokensInUse).toBe(0);
      expect(internals(engine).mobTactics.ledgers.get("p1")?.signatureHolderId ?? null).toBeNull();
      expect(engine.takeImmediateFlush()).toBe(true);
      recorder.step(160);
      expect(recorder.hits.length).toBe(hitsBefore);
      expect(internals(engine).mobCasts.some((c) => c.sourceEntityId === "m")).toBe(false);
      expect(engine.mobTacticsSnapshot().managed).toBe(0);
    });
  }

  it("double strike: killed between the cones, the queued second hit never lands", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "spear", "mossjaw_spearman", at(115, 90));
    engage(engine, "spear");
    const recorder = record(engine);
    recorder.until(() => recorder.casts.some((entry) => entry.abilityId === "skirmisher_double_b"), 400);
    const mob = internals(engine).entities.get("spear")!;
    const hitsBefore = recorder.hits.length;
    internals(engine).defeat(mob, "p1");
    expect(internals(engine).mobCasts.some((c) => c.sourceEntityId === "spear")).toBe(false);
    recorder.step(80);
    expect(recorder.hits.length).toBe(hitsBefore);
    expect(engine.mobTacticsSnapshot().tokensInUse).toBe(0);
  });

  it("a mob with its defeat settlement pending is inert: telegraphs gone, no strike resolves", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "bear", "bear", at(115, 90));
    engage(engine, "bear");
    const recorder = record(engine);
    const bear = internals(engine).entities.get("bear")!;
    recorder.until(() => bear.special?.pendingSignature != null, 400);
    (engine as unknown as { pendingMobDefeats: Map<string, symbol> }).pendingMobDefeats.set("bear", Symbol("pending"));
    (engine as unknown as { cancelMobPendingActions(mob: Entity): void }).cancelMobPendingActions(bear);
    const hitsBefore = recorder.hits.length;
    expect(internals(engine).mobCasts.some((c) => c.sourceEntityId === "bear")).toBe(false);
    recorder.step(120);
    expect(recorder.hits.length).toBe(hitsBefore);
    expect(engine.mobTacticsSnapshot().tokensInUse).toBe(0);
  });

  it("a despawned mob mid-aim or mid-windup takes its telegraph and tokens with it", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "sq", "red_squirrel", at(60, 90));
    engage(engine, "sq");
    const recorder = record(engine);
    const mob = internals(engine).entities.get("sq")!;
    recorder.until(() => mob.special?.pendingBasicStrike != null, 400);
    internals(engine).despawnMob("sq");
    expect(internals(engine).mobCasts.some((c) => c.sourceEntityId === "sq")).toBe(false);
    recorder.step(40);
    expect(recorder.hits).toHaveLength(0);
    expect(engine.mobTacticsSnapshot().tokensInUse).toBe(0);
  });
});
