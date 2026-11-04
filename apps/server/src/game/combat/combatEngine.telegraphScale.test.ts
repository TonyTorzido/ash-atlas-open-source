import { describe, expect, it } from "vitest";

import {
  destinationPoint,
  MOB_ARCHETYPE_PARAMS,
  MOB_MELEE_WINDUP_ID,
  MOB_MELEE_WINDUP_MS,
  MOB_RANGED_AIM_ID,
  MOB_RANGED_AIM_MS,
  MOB_SIGNATURES,
  MOB_TACTICS_MELEE_WINDUP_MS,
  MOB_TACTICS_TOKEN_MAX_HOLD_MS,
  type LatLon
} from "@ash-atlas/shared";
import { zoneIdForPosition } from "../spatialZones.js";
import { CombatEngine } from "./combatEngine.js";
import { resolveArchetypeTactics, signaturePartTicks } from "./mobArchetypeSignatures.js";
import { MobTacticsCoordinator } from "./mobTactics.js";

/**
 * Telegraph time (docs/plans/telegraph-time.md): MOB_TELEGRAPH_SCALE multiplies every managed-mob windup and
 * telegraph, clamped to 1-3, and only while action combat and mob tactics are on.
 */

const origin = { lat: 35.0844, lon: -106.6504 };
const HZ = 20;

type Cast = { sourceEntityId: string; cast: { abilityId: string; castInstanceId: string; startTime: number; resolveTime: number } };
type Entity = { position: LatLon; currentHealth: number; maxHealth: number; attackDamage: number; leashRadiusM: number };
type EngineInternals = {
  entities: Map<string, Entity>;
  mobCasts: Cast[];
  engageHostileMob(mob: Entity, player: Entity, session: unknown): void;
  ensurePveSession(player: Entity): unknown;
};

const internals = (engine: CombatEngine): EngineInternals => engine as unknown as EngineInternals;
const at = (distanceM: number, bearing: number): LatLon => destinationPoint(origin, distanceM, bearing);

function createEngine(scale: number | undefined, flags: { tactics?: boolean; archetypes?: boolean } = {}): CombatEngine {
  let clock = 1_000_000;
  const engine = new CombatEngine({
    tickRateHz: HZ,
    playerMovementSpeedMps: 125,
    isPlayerAuthorityActive: () => true,
    actionCombatEnabled: () => true,
    mobTacticsEnabled: () => flags.tactics ?? true,
    mobArchetypesEnabled: () => flags.archetypes ?? true,
    ...(scale === undefined ? {} : { mobTelegraphScale: () => scale }),
    repositionPlayer: () => true,
    random: () => 0.5,
    now: () => clock
  });
  const tick = engine.tick.bind(engine);
  engine.tick = () => {
    clock += 1_000 / HZ;
    tick();
  };
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: "NM", zoneId: zoneIdForPosition(origin), position: origin,
    accountId: "account-p1", connectionId: "connection-p1",
    profile: { playerId: "p1", maxHealth: 100, currentHealth: 100, baseAttackDamage: 1 }
  });
  const player = internals(engine).entities.get("p1")!;
  player.maxHealth = 1_000_000_000;
  player.currentHealth = 1_000_000_000;
  return engine;
}

function spawnAndEngage(engine: CombatEngine, entityId: string, archetype: string, position: LatLon): void {
  engine.spawnMob({ entityId, archetype: archetype as never, position, regionCode: "NM", zoneId: zoneIdForPosition(position) });
  const mob = internals(engine).entities.get(entityId)!;
  mob.currentHealth = 1_000_000;
  mob.maxHealth = 1_000_000;
  mob.attackDamage = 1;
  mob.leashRadiusM = 0;
  const player = internals(engine).entities.get("p1")!;
  const session = internals(engine).ensurePveSession(player) as { lastMeaningfulEngagementAtMs: number };
  internals(engine).engageHostileMob(mob, player, session);
  session.lastMeaningfulEngagementAtMs = Number.POSITIVE_INFINITY;
}

/** Duration (ms) of the first telegraph `mobId` shows with `abilityId`, within `maxTicks`. */
function firstTelegraphMs(engine: CombatEngine, mobId: string, abilityId: string, maxTicks = 200): number {
  for (let index = 0; index < maxTicks; index += 1) {
    engine.tick();
    const found = internals(engine).mobCasts.find((entry) => entry.sourceEntityId === mobId && entry.cast.abilityId === abilityId);
    if (found) return found.cast.resolveTime - found.cast.startTime;
  }
  throw new Error(`no ${abilityId} telegraph from ${mobId}`);
}

function measure(scale: number | undefined, flags: { tactics?: boolean; archetypes?: boolean }, archetype: string, distanceM: number, abilityId: string): number {
  const engine = createEngine(scale, flags);
  spawnAndEngage(engine, "m1", archetype, at(distanceM, 90));
  return firstTelegraphMs(engine, "m1", abilityId);
}

describe("MOB_TELEGRAPH_SCALE", () => {
  it("scale 2.0 doubles every managed windup: Phase 1 melee, archetype melee, ranged aim, swarm wave, signatures", () => {
    const cases: [flags: { archetypes: boolean }, archetype: string, distanceM: number, abilityId: string, baseMs: number][] = [
      [{ archetypes: false }, "wolf", 110, MOB_MELEE_WINDUP_ID, MOB_TACTICS_MELEE_WINDUP_MS],
      [{ archetypes: true }, "bear", 110, MOB_MELEE_WINDUP_ID, MOB_ARCHETYPE_PARAMS.brute.windupMs],
      [{ archetypes: true }, "hedge_witch", 230, MOB_RANGED_AIM_ID, MOB_ARCHETYPE_PARAMS.caster.windupMs],
      [{ archetypes: true }, "deer", 110, MOB_SIGNATURES.pile_on_wave.abilityIds[0]!, MOB_ARCHETYPE_PARAMS.swarmer.windupMs],
      [{ archetypes: true }, "hog", 300, MOB_SIGNATURES.charge.abilityIds[0]!, MOB_SIGNATURES.charge.telegraphMs[0]!]
    ];
    for (const [flags, archetype, distanceM, abilityId, baseMs] of cases) {
      const one = measure(1, flags, archetype, distanceM, abilityId);
      const two = measure(2, flags, archetype, distanceM, abilityId);
      expect(one, `${archetype} ${abilityId} at 1.0`).toBe(baseMs);
      expect(two, `${archetype} ${abilityId} at 2.0`).toBe(2 * baseMs);
    }
  });

  it("absent means 1.0, and the knob is clamped to 1-3", () => {
    const base = MOB_TACTICS_MELEE_WINDUP_MS;
    expect(measure(undefined, { archetypes: false }, "wolf", 110, MOB_MELEE_WINDUP_ID)).toBe(base);
    expect(measure(0.4, { archetypes: false }, "wolf", 110, MOB_MELEE_WINDUP_ID)).toBe(base);
    expect(measure(Number.NaN, { archetypes: false }, "wolf", 110, MOB_MELEE_WINDUP_ID)).toBe(base);
    expect(measure(9, { archetypes: false }, "wolf", 110, MOB_MELEE_WINDUP_ID)).toBe(3 * base);
    expect(measure(1.5, { archetypes: false }, "wolf", 110, MOB_MELEE_WINDUP_ID)).toBe(Math.round(1.5 * base));
  });

  it("leaves action combat without tactics alone (legacy windup)", () => {
    for (const tactics of [false, true]) {
      // Shared mob combat keeps the legacy scheduled strike even with tactics on (unmanaged mob).
      let clock = 1_000_000;
      const engine = new CombatEngine({
        tickRateHz: HZ, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true,
        actionCombatEnabled: () => true, mobTacticsEnabled: () => tactics, mobTelegraphScale: () => 2,
        isSharedMobCombat: () => true, isMobPlayerAttackAuthorized: () => true,
        random: () => 0.5, now: () => clock
      });
      const tick = engine.tick.bind(engine);
      engine.tick = () => {
        clock += 50;
        tick();
      };
      engine.connectPlayer({
        playerId: "p1", name: "p1", regionCode: "NM", zoneId: "world:NM", position: origin,
        accountId: "account-p1", connectionId: "connection-p1",
        profile: { playerId: "p1", maxHealth: 100, currentHealth: 100, baseAttackDamage: 1 }
      });
      engine.spawnMob({ entityId: "m1", archetype: "wolf", position: at(60, 90), regionCode: "NM", zoneId: "world:NM" });
      internals(engine).entities.get("m1")!.currentHealth = 1_000_000;
      expect(engine.directMobTarget("m1", "p1")).toBe(true);
      expect(firstTelegraphMs(engine, "m1", MOB_MELEE_WINDUP_ID, 120), `tactics ${tactics}`).toBe(MOB_MELEE_WINDUP_MS);
    }
  });

  it("scales signature landing ticks (both double-strike parts) and the token fail-safe", () => {
    const one = resolveArchetypeTactics("centaur_outrider", "common", null, HZ, 1)!;
    const two = resolveArchetypeTactics("centaur_outrider", "common", null, HZ, 2)!;
    expect(one.signature?.kind).toBe("double_strike");
    expect(one.signaturePartTicks).toEqual(signaturePartTicks(MOB_SIGNATURES.double_strike, HZ));
    expect(two.signaturePartTicks).toEqual(one.signaturePartTicks.map((ticks) => ticks * 2));
    expect(two.params.windupMs).toBe(2 * MOB_ARCHETYPE_PARAMS.skirmisher.windupMs);
    expect(two.params.recoverMs).toBe(MOB_ARCHETYPE_PARAMS.skirmisher.recoverMs);
    // The stuck-holder fail-safe grows with the windups: held one tick past 2x the base hold, the token goes back.
    const coordinator = new MobTacticsCoordinator(HZ, () => 2);
    const ledger = coordinator.ledgerFor("p1");
    ledger.arbitrate([{ id: "m1", pool: "melee", cost: 1, waitingSinceTick: 0, distanceM: 100, bearingDeg: 0, grabbed: false, engageRadiusM: 110 }], 0, null);
    const holdTicks = (2 * MOB_TACTICS_TOKEN_MAX_HOLD_MS * HZ) / 1_000;
    expect(ledger.validate(() => true, holdTicks)).toEqual([]);
    expect(ledger.validate(() => true, holdTicks + 1)).toEqual(["m1"]);
  });
});
