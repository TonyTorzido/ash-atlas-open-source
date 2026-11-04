import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CombatEngine } from "./combatEngine.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("tower arrows in the combat engine", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(100_000));
  afterEach(() => vi.useRealTimers());

  it("hits an unarmored player for the Guard Tower row and announces it from the tower", () => {
    const engine = setup();
    connect(engine, "raider", 100);
    expect(engine.applyTowerAttack({ flagId: "flag-1", targetPlayerId: "raider", damageMultiplier: 1 })).toBe(22);
    expect(engine.entity("raider")!.currentHealth).toBe(78);
    const events = engine.beginDeltaFlush().events;
    expect(events.filter((event) => event.sourceEntityId === "tower:flag-1").map((event) => event.type))
      .toEqual(["ATTACK_LANDED", "DAMAGE"]);
    // City / Kingdom Tower level multiplier.
    expect(engine.applyTowerAttack({ flagId: "flag-1", targetPlayerId: "raider", damageMultiplier: 1.5 })).toBe(33);
  });

  it("defeats a player at zero health and ignores defeated or unknown targets", () => {
    const engine = setup();
    connect(engine, "raider", 10);
    expect(engine.applyTowerAttack({ flagId: "flag-1", targetPlayerId: "raider", damageMultiplier: 1 })).toBe(10);
    expect(engine.isPlayerAlive("raider")).toBe(false);
    expect(engine.applyTowerAttack({ flagId: "flag-1", targetPlayerId: "raider", damageMultiplier: 1 })).toBe(0);
    expect(engine.applyTowerAttack({ flagId: "flag-1", targetPlayerId: "nobody", damageMultiplier: 1 })).toBe(0);
  });
});

function setup(): CombatEngine {
  return new CombatEngine({ tickRateHz: 20, playerMovementSpeedMps: 5, random: () => 1 });
}

function connect(engine: CombatEngine, id: string, hp: number): void {
  engine.connectPlayer({ playerId: id, name: id, regionCode: "NM", zoneId: "world:NM", position: origin,
    accountId: `account:${id}`, connectionId: `connection:${id}`,
    profile: { playerId: id, level: 1, maxHealth: 100, currentHealth: hp, baseAttackDamage: 10, defense: 0 } });
}
