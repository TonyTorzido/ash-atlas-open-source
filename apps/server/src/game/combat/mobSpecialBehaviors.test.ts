import { describe, expect, it } from "vitest";
import { destinationPoint, distanceMeters, moveToward, type LatLon } from "@ash-atlas/shared";

import { CombatEngine } from "./combatEngine.js";
import {
  DUNE_TICK_HOP,
  SEWER_SPIDER_WEB,
  SHELLBACK_TURTLE,
  fleaHopCandidates,
  newMobSpecialState,
  shouldWebTarget,
  shouldWithdrawIntoShell,
  spiderlingSwarmDamageFactor
} from "./mobSpecialBehaviors.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const TICK_HZ = 20;

function east(distanceM: number): LatLon {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}

function createEngine(): CombatEngine {
  return new CombatEngine({
    tickRateHz: TICK_HZ,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true
  });
}

function addPlayer(engine: CombatEngine, damage = 10): void {
  engine.connectPlayer({
    playerId: "p1",
    name: "p1",
    regionCode: "NM",
    zoneId: "world:NM",
    position: origin,
    accountId: "account-p1",
    connectionId: "connection-p1",
    profile: { playerId: "p1", maxHealth: 1_000, currentHealth: 1_000, baseAttackDamage: damage }
  });
}

function spawn(engine: CombatEngine, archetype: "shellback_turtle" | "sewer_spider" | "dune_tick", at: LatLon) {
  return engine.spawnMob({
    entityId: `${archetype}:test`,
    archetype,
    position: at,
    homePosition: at,
    regionCode: "NM",
    zoneId: "world:NM",
    worldAi: false
  });
}

function engage(engine: CombatEngine, mobId: string): void {
  engine.startAttack({
    attackerId: "p1", targetEntityId: mobId, requestId: `engage:${mobId}`,
    accountId: "account-p1", connectionId: "connection-p1"
  });
}

/** Aggro needs melee reach; afterwards the player drifts west so the mob has to close the gap. */
function stepPlayerAway(engine: CombatEngine, meters: number): void {
  engine.tick();
  engine.syncPlayer({ playerId: "p1", position: destinationPoint(origin, meters, 270), regionCode: "NM", zoneId: "world:NM" });
}

function rooted(engine: CombatEngine): boolean {
  return (engine.entity("p1")?.controlEffects ?? []).some((effect) => effect.kind === "rooted");
}

describe("Cistern Warrens mob behavior helpers", () => {
  it("only withdraws once, below the threshold, and respects the cooldown", () => {
    const state = newMobSpecialState();
    expect(shouldWithdrawIntoShell(state, 100, 100, 10)).toBe(false);
    expect(shouldWithdrawIntoShell(state, 50, 100, 10)).toBe(true);
    state.shellUntilTick = 90;
    state.nextShellTick = 400;
    expect(shouldWithdrawIntoShell(state, 40, 100, 50)).toBe(false);
    expect(shouldWithdrawIntoShell(state, 40, 100, 200)).toBe(false);
    expect(shouldWithdrawIntoShell(state, 40, 100, 400)).toBe(true);
  });

  it("webs only inside the opening-shot band and on cooldown", () => {
    const state = newMobSpecialState();
    expect(shouldWebTarget(state, SEWER_SPIDER_WEB.minRangeM - 0.1, 0)).toBe(false);
    expect(shouldWebTarget(state, SEWER_SPIDER_WEB.rangeM + 0.1, 0)).toBe(false);
    expect(shouldWebTarget(state, 200, 0)).toBe(true);
    state.nextWebTick = 100;
    expect(shouldWebTarget(state, 200, 99)).toBe(false);
  });

  it("picks deterministic hop landings: beside the target to leap, away from it after a bite", () => {
    const mob = east(300);
    const leap = fleaHopCandidates("leap", "flea:1", 5, mob, origin);
    expect(leap).toEqual(fleaHopCandidates("leap", "flea:1", 5, mob, origin));
    for (const spot of leap) {
      expect(distanceMeters(spot, origin)).toBeLessThan(DUNE_TICK_HOP.leapLandingRadiusM + 1);
    }
    for (const spot of fleaHopCandidates("away", "flea:1", 5, east(10), origin)) {
      expect(distanceMeters(spot, east(10))).toBeGreaterThan(DUNE_TICK_HOP.awayDistanceM - 2);
    }
  });

  it("caps the spiderling swarm bonus", () => {
    expect(spiderlingSwarmDamageFactor(0)).toBe(1);
    expect(spiderlingSwarmDamageFactor(2)).toBeCloseTo(1.3);
    expect(spiderlingSwarmDamageFactor(20)).toBeCloseTo(1.45);
  });
});

describe("Cistern Warrens mob behavior in the combat engine", () => {
  it("shell-back turtle is immune and inert while shelled, then resumes taking damage", () => {
    const engine = createEngine();
    // Small hits: the turtle has little health behind chainmail, so one big blow
    // could jump straight past the half-health shell threshold.
    addPlayer(engine, 4);
    const turtle = spawn(engine, "shellback_turtle", east(1));
    const max = turtle.maxHealth;
    const internals = engine as unknown as { entities: Map<string, { currentHealth: number }> };
    internals.entities.get(turtle.entityId)!.currentHealth = Math.ceil(max * 0.5) + 2;

    engage(engine, turtle.entityId);
    let shelledHealth: number | null = null;
    let shellStartTick = -1;
    for (let tick = 0; tick < 400 && shellStartTick < 0; tick += 1) {
      engine.tick();
      const health = engine.entity(turtle.entityId)!.currentHealth;
      if (health <= max * 0.5 && health > 0) { shelledHealth = health; shellStartTick = tick; }
    }
    expect(shellStartTick).toBeGreaterThanOrEqual(0);
    expect((engine.entity(turtle.entityId)!.controlEffects ?? []).some((e) => e.kind === "rooted")).toBe(true);

    const shellTicks = Math.floor(SHELLBACK_TURTLE.shellDurationMs * TICK_HZ / 1_000);
    for (let tick = 0; tick < shellTicks - 4; tick += 1) engine.tick();
    expect(engine.entity(turtle.entityId)!.currentHealth).toBe(shelledHealth);

    for (let tick = 0; tick < 60; tick += 1) engine.tick();
    expect(engine.entity(turtle.entityId)!.currentHealth).toBeLessThan(shelledHealth!);
  });

  it("sewer spider web roots the target for about two seconds and then expires", () => {
    const engine = createEngine();
    addPlayer(engine);
    const spider = spawn(engine, "sewer_spider", east(90));
    engage(engine, spider.entityId);
    stepPlayerAway(engine, 160);

    let rootedAt = -1;
    for (let tick = 0; tick < 10 && rootedAt < 0; tick += 1) {
      engine.tick();
      if (rooted(engine)) rootedAt = tick;
    }
    expect(rootedAt).toBeGreaterThanOrEqual(0);
    const rootTicks = Math.ceil(SEWER_SPIDER_WEB.rootDurationMs * TICK_HZ / 1_000);
    for (let tick = 0; tick < rootTicks - 4; tick += 1) engine.tick();
    expect(rooted(engine)).toBe(true);
    for (let tick = 0; tick < 8; tick += 1) engine.tick();
    expect(rooted(engine)).toBe(false);
  });

  it("dune tick leaps to the target in a single tick instead of walking", () => {
    const engine = createEngine();
    addPlayer(engine, 1);
    const flea = spawn(engine, "dune_tick", east(90));
    engage(engine, flea.entityId);
    stepPlayerAway(engine, 310);
    const walkStepM = 2;

    let previous: LatLon = { lat: flea.lat, lon: flea.lon };
    let biggestJump = 0;
    for (let tick = 0; tick < 120; tick += 1) {
      engine.tick();
      const now = engine.entity(flea.entityId)!;
      const here = { lat: now.lat, lon: now.lon };
      biggestJump = Math.max(biggestJump, distanceMeters(previous, here));
      previous = here;
    }
    expect(biggestJump).toBeGreaterThan(walkStepM * 3);
    expect(biggestJump).toBeGreaterThan(200);
  });
});
