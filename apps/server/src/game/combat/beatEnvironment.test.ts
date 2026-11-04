import { describe, expect, it } from "vitest";

import * as shared from "@ash-atlas/shared";
import {
  BASIC_ATTACK_INTERVAL_MS,
  BONE_THRALL_MAX_LEVEL,
  GROVE_AURA_TICK_MS,
  HEAL_ZONE_TICK_MS,
  MONOLITH_HEALER_TICK_MS,
  beatAlignedIntervalMs,
  boneThrallStats
} from "@ash-atlas/shared";

import { TOWER_VOLLEY_TICK_MS } from "../towerVolleys.js";
import { METAL_PROC_BALANCE } from "./metalProcs.js";
import { CombatEngine } from "./combatEngine.js";
import { BLIGHT_TREANT, RAPTOR_SPITTER } from "./mobSpecialBehaviors.js";

function expectWholeBeats(label: string, intervalMs: number): void {
  expect(intervalMs, `${label} must be positive`).toBeGreaterThan(0);
  expect(intervalMs % BASIC_ATTACK_INTERVAL_MS, `${label} (${intervalMs} ms) must be a whole multiple of the ${BASIC_ATTACK_INTERVAL_MS} ms beat`).toBe(0);
}

/** Shared `*_TICK_MS` exports that are not combat or world effects (work-in-progress billing chunks). */
const NON_EFFECT_TICK_CONSTANTS: ReadonlySet<string> = new Set(["STRUCTURE_WARFARE_REPAIR_TICK_MS"]);

describe("1.4 s environment: periodic heal and damage ticks sit on the beat", () => {
  it("keeps every directly-timed heal and damage tick a whole multiple of the beat", () => {
    expectWholeBeats("GROVE_AURA_TICK_MS", GROVE_AURA_TICK_MS);
    expectWholeBeats("HEAL_ZONE_TICK_MS", HEAL_ZONE_TICK_MS);
    expectWholeBeats("MONOLITH_HEALER_TICK_MS", MONOLITH_HEALER_TICK_MS);
    expectWholeBeats("TOWER_VOLLEY_TICK_MS", TOWER_VOLLEY_TICK_MS);
    expectWholeBeats("RAPTOR_SPITTER.zoneTickMs", RAPTOR_SPITTER.zoneTickMs);
    expectWholeBeats("BLIGHT_TREANT.regenIntervalMs", BLIGHT_TREANT.regenIntervalMs);
    for (let level = 1; level <= BONE_THRALL_MAX_LEVEL; level += 1) {
      expectWholeBeats(`Bone Thrall level ${level} selfHealIntervalMs`, boneThrallStats(level).selfHealIntervalMs);
    }
  });

  it("scans every shared *_TICK_MS export so a new periodic effect cannot drift off the beat", () => {
    const tickConstants = Object.entries(shared)
      .filter(([name, value]) => /_TICK_MS$/u.test(name) && typeof value === "number" && !NON_EFFECT_TICK_CONSTANTS.has(name));
    expect(tickConstants.map(([name]) => name)).toEqual(expect.arrayContaining([
      "GROVE_AURA_TICK_MS", "HEAL_ZONE_TICK_MS", "MONOLITH_HEALER_TICK_MS"
    ]));
    for (const [name, value] of tickConstants) expectWholeBeats(name, value as number);
  });

  it("aligns the design-interval metal ticks, which the engine rounds to whole beats at runtime", () => {
    // These are the design intervals; the engine ticks them at beatAlignedIntervalMs (see periodicBeatTicks.test.ts).
    for (const [label, designMs] of [
      ["Venom", METAL_PROC_BALANCE.poison.tickMs],
      ["Ember", METAL_PROC_BALANCE.burning.tickMs],
      ["Storm", METAL_PROC_BALANCE.storm.pulseMs]
    ] as const) {
      expectWholeBeats(`${label} beat interval`, beatAlignedIntervalMs(designMs));
    }
  });

  it.each([
    ["spitter acid (3 s)", 3_000],
    ["squid ink (4 s)", 4_000],
    ["Hollow Elder spore cloud (6 s)", 6_000]
  ])("keeps the total damage of a %s cloud over its life", (_label, durationMs) => {
    const { engine, internal, mobId, playerHealth } = cloudWorld();
    const tick = internal.currentTick;
    internal.acidZones.push({
      sourceEntityId: mobId, center: ORIGIN, landTick: tick, endTick: tick + durationMs * HZ / 1_000,
      nextTick: tick, damage: 10, radiusM: 200, techniqueId: "beat_environment_cloud"
    });
    for (let index = 0; index < (durationMs + 2 * BASIC_ATTACK_INTERVAL_MS) * HZ / 1_000; index += 1) engine.tick();
    // Designed as one hit of 10 per second of the cloud life.
    expect(100_000 - playerHealth()).toBe(10 * (durationMs / 1_000));
  });

  it("keeps Black Rain at its old 30 total damage over 6 s (7, 8, 7, 8 on four beats)", () => {
    const { engine, internal, mobId, playerHealth } = cloudWorld();
    internal.applyV2Zone(
      internal.entities.get("p1")!, "ranger_v2_black_rain", ORIGIN, 6_000, BASIC_ATTACK_INTERVAL_MS,
      5 * Math.floor(6_000 / 1_000) / Math.floor(6_000 / BASIC_ATTACK_INTERVAL_MS), "hostile"
    );
    const before = internal.entities.get(mobId)!.currentHealth;
    for (let index = 0; index < (6_000 + 2 * BASIC_ATTACK_INTERVAL_MS) * HZ / 1_000; index += 1) engine.tick();
    expect(before - internal.entities.get(mobId)!.currentHealth).toBe(30);
    expect(playerHealth()).toBe(100_000);
  });

  it("keeps Bone Thrall self-heal per second close to the design 9% per 12 s to 9.6 s", () => {
    for (let level = 1; level <= BONE_THRALL_MAX_LEVEL; level += 1) {
      const stats = boneThrallStats(level);
      const designIntervalMs = 12_000 - (level - 1) * 600;
      expect(stats.selfHealFraction / stats.selfHealIntervalMs).toBeCloseTo(0.09 / designIntervalMs, 10);
    }
  });
});

const HZ = 20;
const ORIGIN = { lat: 35.0844, lon: -106.6504 };

type CloudInternals = {
  currentTick: number;
  acidZones: Array<Record<string, unknown>>;
  entities: Map<string, { currentHealth: number; maxHealth: number }>;
  applyV2Zone(source: unknown, abilityId: string, position: typeof ORIGIN, durationMs: number, intervalMs: number, amount: number, kind: string): void;
};

/** A player standing in the zone and an idle mob that owns it. */
function cloudWorld() {
  const engine = new CombatEngine({ tickRateHz: HZ, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true });
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: "NM", zoneId: "world:NM", position: ORIGIN,
    accountId: "account-p1", connectionId: "connection-p1",
    profile: { playerId: "p1", maxHealth: 100_000, currentHealth: 100_000, baseAttackDamage: 1, defense: 0 }
  });
  const mob = engine.spawnMob({
    archetype: "goblin", position: ORIGIN, homePosition: ORIGIN, regionCode: "NM", zoneId: "world:NM"
  });
  const internal = engine as unknown as CloudInternals;
  const mobInternal = internal.entities.get(mob.entityId)!;
  mobInternal.currentHealth = mobInternal.maxHealth = 100_000;
  return { engine, internal, mobId: mob.entityId, playerHealth: () => internal.entities.get("p1")!.currentHealth };
}
