import {
  DASH_COOLDOWN_MS,
  DASH_DISTANCE_M,
  DASH_DURATION_MS,
  DASH_IFRAME_MS,
  destinationPoint,
  distanceMeters
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { CombatEngine } from "./combat/combatEngine.js";
import { DashRejectedError, GameState } from "./state.js";

const T0 = 1_000_000;

function setup(): { state: GameState; clock: { now: number }; playerId: string } {
  const state = new GameState(loadConfig({ NODE_ENV: "test" }));
  const clock = { now: T0 };
  state.setDashClock(() => clock.now);
  const player = state.helloPlayer("dasher", "Dasher");
  return { state, clock, playerId: player.playerId };
}

/** Runs the 20 Hz tick for `ms`, advancing the dash clock alongside. */
function run(state: GameState, clock: { now: number }, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    clock.now += 50;
    state.tick(0.05);
  }
}

function dash(state: GameState, playerId: string, dirX: number, dirY: number, requestId = "d1") {
  const end = state.planDash(playerId, dirX, dirY);
  return state.startDash(playerId, requestId, end);
}

describe("overworld dash", () => {
  it("moves the full distance in about the dash duration and ends stationary", () => {
    const { state, clock, playerId } = setup();
    const start = { ...state.getPlayer(playerId)!.position };
    dash(state, playerId, 1, 0);
    expect(state.snapshotForPlayer(playerId).dash).toMatchObject({ active: true, startedAt: T0 });
    run(state, clock, DASH_DURATION_MS - 50);
    expect(state.isDashing(playerId)).toBe(true);
    run(state, clock, 100);
    const player = state.getPlayer(playerId)!;
    expect(state.isDashing(playerId)).toBe(false);
    expect(player.target).toBeNull();
    expect(distanceMeters(start, player.position)).toBeCloseTo(DASH_DISTANCE_M, 0);
    // East: same latitude, larger longitude.
    expect(player.position.lon).toBeGreaterThan(start.lon);
    const snapshot = state.snapshotForPlayer(playerId);
    expect(snapshot.moving).toBe(false);
    expect(snapshot.dash).toMatchObject({ active: false, cooldownUntil: T0 + DASH_COOLDOWN_MS });
  });

  it("enforces the cooldown and drops the dash state once it expires", () => {
    const { state, clock, playerId } = setup();
    dash(state, playerId, 0, 1);
    run(state, clock, 300);
    expect(() => state.planDash(playerId, 0, -1)).toThrow(/recharging/i);
    clock.now = T0 + DASH_COOLDOWN_MS;
    expect(() => dash(state, playerId, 0, -1, "d2")).not.toThrow();
    run(state, clock, 300);
    clock.now = T0 + DASH_COOLDOWN_MS * 3;
    expect(state.snapshotForPlayer(playerId).dash).toBeUndefined();
  });

  it("clamps the end inside the movement leash and rejects a dash with nowhere to go", () => {
    const { state, playerId } = setup();
    const player = state.getPlayer(playerId)!;
    // Stand 40 m inside the leash edge, facing out.
    player.position = destinationPoint(player.anchor, player.moveLeashRadiusM - 40, 90);
    const end = state.planDash(playerId, 1, 0);
    expect(distanceMeters(player.anchor, end)).toBeLessThanOrEqual(player.moveLeashRadiusM);
    expect(distanceMeters(player.position, end)).toBeGreaterThan(35);
    expect(distanceMeters(player.position, end)).toBeLessThan(41);
    player.position = destinationPoint(player.anchor, player.moveLeashRadiusM - 0.5, 90);
    expect(() => state.planDash(playerId, 1, 0)).toThrow(DashRejectedError);
    // Inward is still fine.
    expect(() => state.planDash(playerId, -1, 0)).not.toThrow();
  });

  it("never accepts a client-chosen end beyond the dash distance or the leash", () => {
    const { state, playerId } = setup();
    const player = state.getPlayer(playerId)!;
    const tooFar = destinationPoint(player.position, DASH_DISTANCE_M * 2, 0);
    expect(() => state.startDash(playerId, "far", tooFar)).toThrow(/further/i);
  });

  it("rejects while movement-blocked, afloat, or in a water leg", () => {
    const { state, playerId } = setup();
    state.setMovementBlocked(playerId, true, "fishing");
    expect(() => state.planDash(playerId, 1, 0)).toThrow(/right now/i);
    state.setMovementBlocked(playerId, false, "fishing");
    state.setAfloat(playerId, true, false);
    expect(() => state.planDash(playerId, 1, 0)).toThrow(/water/i);
    state.setAfloat(playerId, false, false);
    state.setWorldPresence(playerId, false);
    expect(() => state.planDash(playerId, 1, 0)).toThrow(/overworld/i);
  });

  it("allows a dash while walking an all-land leg, but not while a leg crosses water", () => {
    const { state, playerId } = setup();
    const player = state.getPlayer(playerId)!;
    const landLeg = {
      origin: { ...player.position },
      relocationRevision: player.relocationRevision ?? 0,
      segments: [{ startM: 0, multiplier: 1, surface: "land" as const }]
    };
    // Regression: every MOVE_TO carries a water-plan leg, so walking used to read as "on the water".
    state.setTarget(playerId, destinationPoint(player.position, 300, 90), landLeg);
    expect(() => state.planDash(playerId, 0, 1)).not.toThrow();
    const wetLeg = {
      ...landLeg,
      segments: [{ startM: 0, multiplier: 1, surface: "land" as const }, { startM: 100, multiplier: 0.5, surface: "open_water" as const }]
    };
    state.setTarget(playerId, destinationPoint(player.position, 280, 90), wetLeg);
    expect(() => state.planDash(playerId, 0, 1)).toThrow(/water/i);
  });

  it("queues a move sent mid-dash and starts it when the dash lands", () => {
    const { state, clock, playerId } = setup();
    const { dash: started } = dash(state, playerId, 1, 0);
    const after = destinationPoint(started.to, 50, 0);
    state.setTarget(playerId, after);
    expect(state.pendingTargetAfterDash(playerId)).toEqual(after);
    expect(state.getPlayer(playerId)!.target).toBe(started.to);
    run(state, clock, DASH_DURATION_MS + 50);
    expect(state.getPlayer(playerId)!.target).toEqual(after);
  });

  it("grants i-frames for the dash window only", () => {
    const { state, clock, playerId } = setup();
    expect(state.isDashInvulnerable(playerId)).toBe(false);
    dash(state, playerId, 1, 0);
    expect(state.isDashInvulnerable(playerId)).toBe(true);
    clock.now = T0 + DASH_IFRAME_MS - 1;
    expect(state.isDashInvulnerable(playerId)).toBe(true);
    clock.now = T0 + DASH_IFRAME_MS;
    expect(state.isDashInvulnerable(playerId)).toBe(false);
  });

  it("skips mob damage, including scripted telegraph hits, during the i-frames", () => {
    const { state, clock, playerId } = setup();
    const engine = new CombatEngine({
      tickRateHz: 20,
      playerMovementSpeedMps: 5,
      random: () => 1,
      isEntityInvulnerable: (entityId) => state.isDashInvulnerable(entityId)
    });
    const position = state.getPlayer(playerId)!.position;
    engine.connectPlayer({
      playerId, name: playerId, regionCode: "NM", zoneId: "world:NM", position,
      accountId: `account:${playerId}`, connectionId: `connection:${playerId}`,
      profile: { playerId, level: 1, maxHealth: 100, currentHealth: 100, baseAttackDamage: 10, defense: 0 }
    });
    const mob = engine.spawnMob({
      archetype: "wolf", position: destinationPoint(position, 20, 90), regionCode: "NM", zoneId: "world:NM"
    });
    dash(state, playerId, 0, 1);
    expect(engine.applyScriptedDamage(mob.entityId, playerId, 10, "ogre_slam")).toBe(0);
    expect(engine.applyScriptedDamage(mob.entityId, playerId, 10, "enemy_basic_attack")).toBe(0);
    expect(engine.entity(playerId)!.currentHealth).toBe(100);
    clock.now = T0 + DASH_IFRAME_MS + 1;
    expect(engine.applyScriptedDamage(mob.entityId, playerId, 10, "ogre_slam")).toBeGreaterThan(0);
  });
});
