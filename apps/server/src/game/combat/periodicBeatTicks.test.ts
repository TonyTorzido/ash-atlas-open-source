import { describe, expect, it } from "vitest";

import {
  BASIC_ATTACK_INTERVAL_MS,
  PVE_TURN_STEP_MS,
  beatAlignedIntervalMs,
  destinationPoint,
  type CombatEvent,
  type LatLon
} from "@ash-atlas/shared";

import { CombatEngine } from "./combatEngine.js";
import { METAL_PROC_BALANCE } from "./metalProcs.js";

const HZ = 20;
const ORIGIN = { lat: 35.0844, lon: -106.6504 };
const BEAT = BASIC_ATTACK_INTERVAL_MS * HZ / 1_000;
const HALF = PVE_TURN_STEP_MS * HZ / 1_000;

type Effect = { kind: string; sourceEntityId: string; stacks: number };
type Internal = { entityId: string; currentHealth: number; maxHealth: number; classRuntime: { effects: Effect[] } | null };
type Internals = {
  currentTick: number;
  entities: Map<string, Internal>;
  pveSessions: Map<string, { playerTurnAnchorTick: number | null }>;
  applyMetalEffect(owner: Internal, opponent: Internal, effectId: string, procSource: "weapon" | "armor"): void;
  applyHarmfulStatus(source: Internal, target: Internal, statusId: string, chance: number): boolean;
};

describe("beat-aligned periodic ticks", () => {
  it("ticks a player-applied DoT on the player half even when an armor proc applies it on the enemy beat", () => {
    const fight = startFight();
    const enemyTick = fight.tickUntil((events) => events.some(isHit(fight.mobId, "p1")));
    expect(fight.offset(enemyTick)).toBe(HALF);
    // A reactive armor proc lands on the monster's own attack tick.
    fight.internal.applyMetalEffect(fight.player(), fight.mob(), "poison", "armor");

    const trace = fight.trace(10 * BEAT, fight.mobId, "poison");
    expect(trace.pulseTicks.length).toBeGreaterThanOrEqual(4);
    const interval = beatAlignedIntervalMs(METAL_PROC_BALANCE.poison.tickMs) * HZ / 1_000;
    expect(interval % BEAT).toBe(0);
    trace.pulseTicks.slice(1).forEach((tick, index) => expect(tick - trace.pulseTicks[index]!).toBe(interval));
    for (const tick of trace.pulseTicks) {
      expect(trace.offsets.get(tick), `poison tick ${tick}`).toBeLessThan(HALF);
      expect(trace.enemyHitTicks).not.toContain(tick);
    }
  });

  it("ticks a monster-applied DoT on the enemy half even when it lands on the player's beat", () => {
    const fight = startFight();
    fight.tickUntil((events) => events.some(isHit(fight.mobId, "p1")));
    const playerTick = fight.tickUntil((events) => events.some(isHit("p1", fight.mobId)));
    expect(fight.offset(playerTick)).toBe(0);
    fight.internal.applyHarmfulStatus(fight.mob(), fight.player(), "poison", 1);

    const trace = fight.trace(12 * BEAT, "p1", "poison");
    const pulses = Math.round(12_000 / beatAlignedIntervalMs(2_000));
    expect(trace.pulseTicks).toHaveLength(pulses);
    trace.pulseTicks.slice(1).forEach((tick, index) =>
      expect(tick - trace.pulseTicks[index]!).toBe(beatAlignedIntervalMs(2_000) * HZ / 1_000));
    for (const tick of trace.pulseTicks) {
      expect(trace.offsets.get(tick), `poison tick ${tick}`).toBeGreaterThanOrEqual(HALF);
      expect(trace.playerHitTicks).not.toContain(tick);
    }
  });

  it("waits for its own half after the turn re-anchors instead of sharing the opposing tick", () => {
    const fight = startFight();
    const enemyTick = fight.tickUntil((events) => events.some(isHit(fight.mobId, "p1")));
    fight.internal.applyMetalEffect(fight.player(), fight.mob(), "poison", "weapon");
    const poison = fight.effect(fight.mobId, "poison")!;
    const pulsesBefore = poison.stacks;
    // Shift the player's turn by half a beat: the queued pulse now falls on the enemy half.
    fight.internal.pveSessions.get("p1")!.playerTurnAnchorTick = enemyTick;
    const trace = fight.trace(4 * BEAT, fight.mobId, "poison");
    expect(trace.pulseTicks.length).toBeGreaterThan(0);
    for (const tick of trace.pulseTicks) expect(trace.offsets.get(tick)).toBeLessThan(HALF);
    expect(pulsesBefore - fight.effect(fight.mobId, "poison")!.stacks).toBe(trace.pulseTicks.length);
  });
});

function startFight() {
  const engine = new CombatEngine({ tickRateHz: HZ, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true });
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: "NM", zoneId: "world:NM", position: ORIGIN,
    accountId: "account-p1", connectionId: "connection-p1",
    profile: { playerId: "p1", maxHealth: 100_000, currentHealth: 100_000, baseAttackDamage: 1, defense: 0 }
  });
  const mob = engine.spawnMob({
    archetype: "goblin", position: east(10), homePosition: east(10), regionCode: "NM", zoneId: "world:NM"
  });
  const internal = engine as unknown as Internals;
  const mobInternal = internal.entities.get(mob.entityId)!;
  mobInternal.currentHealth = mobInternal.maxHealth = 100_000;
  engine.startAttack({
    attackerId: "p1", targetEntityId: mob.entityId, requestId: "beat-fight",
    accountId: "account-p1", connectionId: "connection-p1"
  });
  engine.beginDeltaFlush();
  const effect = (entityId: string, kind: string) =>
    internal.entities.get(entityId)?.classRuntime?.effects.find((entry) => entry.kind === kind);
  /** Ticks past the player's beat point, from the live turn anchor. */
  const offset = (tick: number) => {
    const anchor = internal.pveSessions.get("p1")?.playerTurnAnchorTick ?? 0;
    return ((tick - anchor) % BEAT + BEAT) % BEAT;
  };
  const step = (): { tick: number; events: CombatEvent[] } => {
    engine.tick();
    return { tick: internal.currentTick, events: engine.beginDeltaFlush().events };
  };
  return {
    engine, internal, mobId: mob.entityId, effect, offset,
    player: () => internal.entities.get("p1")!,
    mob: () => internal.entities.get(mob.entityId)!,
    tickUntil(predicate: (events: CombatEvent[]) => boolean): number {
      for (let index = 0; index < 10 * BEAT; index += 1) {
        const { tick, events } = step();
        if (predicate(events)) return tick;
      }
      throw new Error("condition never met");
    },
    /** Per tick: when the effect pulsed, the beat offset then, and both sides' attack ticks. */
    trace(ticks: number, entityId: string, kind: string) {
      const pulseTicks: number[] = [];
      const enemyHitTicks: number[] = [];
      const playerHitTicks: number[] = [];
      const offsets = new Map<number, number>();
      let stacks = effect(entityId, kind)?.stacks ?? 0;
      for (let index = 0; index < ticks; index += 1) {
        const { tick, events } = step();
        offsets.set(tick, offset(tick));
        if (events.some(isHit(mob.entityId, "p1"))) enemyHitTicks.push(tick);
        if (events.some(isHit("p1", mob.entityId))) playerHitTicks.push(tick);
        const next = effect(entityId, kind)?.stacks ?? 0;
        if (next < stacks) pulseTicks.push(tick);
        stacks = next;
      }
      return { pulseTicks, enemyHitTicks, playerHitTicks, offsets };
    }
  };
}

function isHit(sourceEntityId: string, targetEntityId: string) {
  return (event: CombatEvent) =>
    event.type === "ATTACK_LANDED" && event.sourceEntityId === sourceEntityId && event.targetEntityId === targetEntityId;
}

function east(distanceM: number): LatLon {
  return destinationPoint(ORIGIN, distanceM, 90);
}
