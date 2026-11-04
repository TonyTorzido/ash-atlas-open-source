import { DASH_COOLDOWN_MS } from "./dash.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_PLAYER_SPEED_MPS } from "./gameplayArea.js";
import {
  MOB_ARCHETYPE_IDS,
  MOB_ARCHETYPE_PARAMS,
  MOB_ARCHETYPE_SIGNATURES,
  MOB_ARCH_BASIC_CEILING_MULTIPLIER,
  MOB_ARCH_CASTER_RANGED_TOKENS,
  MOB_ARCH_CASTER_REACH_OVERRIDE_KEYS,
  MOB_ARCH_GOVERNOR_BUDGET_HE,
  MOB_ARCH_GOVERNOR_WINDOW_MS,
  MOB_ARCH_MAX_SPEED_SHARE,
  MOB_ARCH_PHASE1_CEILING_HE_PER_SEC,
  MOB_ARCH_PHASE1_LONE_HE_PER_SEC,
  MOB_ARCH_REFERENCE_CYCLE_MS,
  MOB_ARCH_SIGNATURE_CEILING_MULTIPLIER,
  MOB_ARCH_SIGNATURE_MIN_SPACING_MS,
  MOB_ARCH_SIGNATURE_MIN_TELEGRAPH_MS,
  MOB_ARCH_SIGNATURE_REACTION_SLACK_MS,
  MOB_SIGNATURES,
  MOB_SIGNATURE_ABILITY_IDS,
  mobArchetypeAssignment,
  mobArchetypeCeilingHePerSec,
  mobArchetypeCycleMs,
  mobArchetypeHePerPointSecond,
  mobArchetypeLoneHePerSec,
  mobArchetypePackHePerSec,
  mobArchetypeReachOverrideM,
  mobArchetypeRhythm,
  mobArchetypeSpeedMps,
  mobSignatureWalkOutMs,
  scaleMobArchetypeParams,
  scaleMobSignature,
  type MobArchetypeId,
  type MobSignatureKind
} from "./mobArchetypes.js";
import { MOB_SPAWN_KINDS } from "./mobSpawnRules.js";
import {
  MOB_RANGED_AIM_WIDTH_M,
  MOB_TACTICS_MELEE_REACH_M,
  MOB_TACTICS_MELEE_REACH_SLACK_M,
  MOB_TACTICS_MELEE_TOKENS,
  MOB_TACTICS_MELEE_WINDUP_MS,
  deriveMobRhythm,
  mobTacticsTokenMaxHoldMs
} from "./mobTactics.js";
import { SWING_RANGE_M } from "./actionCombat.js";
import { PLAYER_HURT_RADIUS_M, mobHurtRadiusM } from "./hitGeometry.js";

const EXPECTED_COUNTS: Record<MobArchetypeId, number> = { brute: 64, pack: 10, skirmisher: 7, caster: 17, swarmer: 29 };

describe("mob archetype mapping", () => {
  it("maps every spawnable overworld mob, except the one excluded mob", () => {
    const unmapped = MOB_SPAWN_KINDS.filter((kind) => mobArchetypeAssignment(kind) === null);
    expect(unmapped).toEqual(["drowned_citizen"]);
  });

  it("gives the expected archetype counts over the whole roster", () => {
    const counts: Record<string, number> = {};
    for (const kind of MOB_SPAWN_KINDS) {
      const assignment = mobArchetypeAssignment(kind);
      if (assignment) counts[assignment.archetype] = (counts[assignment.archetype] ?? 0) + 1;
    }
    expect(MOB_SPAWN_KINDS.length).toBe(128);
    expect(counts).toEqual(EXPECTED_COUNTS);
  });

  it("only pairs an archetype with signatures it may use", () => {
    for (const kind of MOB_SPAWN_KINDS) {
      const assignment = mobArchetypeAssignment(kind);
      if (!assignment) continue;
      expect(MOB_ARCHETYPE_SIGNATURES[assignment.archetype], kind).toContain(assignment.signature);
    }
  });

  it("keeps the shell and quill mobs without an offensive signature", () => {
    for (const kind of ["spur_thighed_tortoise", "snapping_turtle", "kappa", "kappa_brawler", "shellback", "crested_porcupine"]) {
      expect(mobArchetypeAssignment(kind)).toEqual({ archetype: "brute", signature: "none" });
    }
  });

  it("maps the spot-checked families from the spec", () => {
    const expectOf = (kind: string, archetype: MobArchetypeId, signature: MobSignatureKind): void =>
      expect(mobArchetypeAssignment(kind), kind).toEqual({ archetype, signature });
    expectOf("wolf", "pack", "lunge");
    expectOf("frost_wolf", "pack", "lunge");
    expectOf("jaguar", "pack", "lunge");
    expectOf("hog", "brute", "charge");
    expectOf("caiman", "brute", "charge");
    expectOf("bear", "brute", "maul");
    expectOf("barrow_wight", "brute", "maul");
    expectOf("moss_golem", "brute", "slam");
    expectOf("jellyfish", "brute", "slam");
    expectOf("bog_hag", "skirmisher", "smoke_step");
    expectOf("golden_eagle", "skirmisher", "swoop");
    expectOf("mossjaw_spearman", "skirmisher", "double_strike");
    expectOf("hedge_witch", "caster", "ground_blast");
    expectOf("kraken", "caster", "ground_blast");
    expectOf("gnoll_bonebow", "caster", "volley");
    expectOf("poison_frog", "caster", "tongue");
    expectOf("red_squirrel", "swarmer", "pile_on_wave");
    expectOf("vine_lurker", "swarmer", "pile_on_wave");
  });

  it("gives a reach override only to the four humanoid casters", () => {
    for (const kind of MOB_SPAWN_KINDS) {
      const reach = mobArchetypeReachOverrideM(kind);
      expect(reach !== null, kind).toBe(MOB_ARCH_CASTER_REACH_OVERRIDE_KEYS.includes(kind));
      if (reach !== null) expect(mobArchetypeAssignment(kind)?.archetype).toBe("caster");
    }
  });
});

describe("mob archetype rhythm and speed", () => {
  it("has positive phases and a cycle that matches the spec", () => {
    // Telegraph time: the longer windups lengthen every cycle (cooldowns unchanged; 13-24 % fewer hits from a lone mob).
    const cycles: Record<MobArchetypeId, number> = { brute: 2_650, pack: 1_750, skirmisher: 2_200, caster: 1_850, swarmer: 1_500 };
    for (const id of MOB_ARCHETYPE_IDS) {
      const p = MOB_ARCHETYPE_PARAMS[id];
      expect(p.windupMs).toBeGreaterThan(0);
      expect(p.recoverMs, `${id} recover stays readable`).toBeGreaterThanOrEqual(250);
      expect(p.cooldownMs).toBeGreaterThan(0);
      expect(mobArchetypeCycleMs(id)).toBe(cycles[id]);
    }
  });

  it("keeps the design-rule hit factors (rule 7: per-type speed, damage per second kept)", () => {
    const factors: Record<MobArchetypeId, number> = { brute: 1.5, pack: 1, skirmisher: 1.3, caster: 1.1, swarmer: 0.8 };
    for (const id of MOB_ARCHETYPE_IDS) expect(MOB_ARCHETYPE_PARAMS[id].basicDamageFactor, id).toBe(factors[id]);
    expect(MOB_ARCH_REFERENCE_CYCLE_MS).toBe(1_400);
  });

  it("feeds deriveMobRhythm through the Phase 1 override shape", () => {
    for (const id of MOB_ARCHETYPE_IDS) {
      const rhythm = deriveMobRhythm(1_400, id === "caster" ? 260 : 100, mobArchetypeRhythm(id));
      expect(rhythm).toEqual(mobArchetypeRhythm(id));
    }
  });

  it("never lets an archetype outrun the player", () => {
    const player = DEFAULT_PLAYER_SPEED_MPS;
    for (const id of MOB_ARCHETYPE_IDS) {
      for (const burst of [false, true]) {
        expect(mobArchetypeSpeedMps(500, id, player, burst)).toBeLessThanOrEqual(player * MOB_ARCH_MAX_SPEED_SHARE + 1e-9);
      }
    }
    expect(mobArchetypeSpeedMps(0.75 * player, "pack", player)).toBeCloseTo(0.75 * player * 1.15, 6);
  });
});

describe("mob archetype signatures", () => {
  it("registers every signature telegraph id once and every non-none mapping has a table row", () => {
    const ids = Object.values(MOB_SIGNATURES).flatMap((s) => [...s.abilityIds]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MOB_SIGNATURE_ABILITY_IDS.size).toBe(ids.length);
    for (const kind of MOB_SPAWN_KINDS) {
      const assignment = mobArchetypeAssignment(kind);
      if (assignment && assignment.signature !== "none") {
        expect(MOB_SIGNATURES[assignment.signature].archetype, kind).toBe(assignment.archetype);
      }
    }
  });

  /**
   * Worst-case walk-out distance from the spot the player is most likely to be caught in (docs/plans/combat-feel.md):
   * a cone aimed at the player of half-angle h and range L is worst at d = L / (1 + sin h), L sin h / (1 + sin h) to
   * leave; a lane is half its width; a circle its radius; the volley centre lane half its width into the gap. Lanes and
   * cones add the player hurt circle (the whole body must leave); circles are drawn PLAYER_HURT_RADIUS_M smaller, so
   * their effective radius is the table value.
   */
  const coneWorstM = (rangeM: number, angleDeg: number): number => {
    const s = Math.sin(((angleDeg / 2) * Math.PI) / 180);
    return (rangeM * s) / (1 + s);
  };
  it("lets a reacting player WALK out of every signature: each telegraph part >= walk out + 400 ms", () => {
    const walkOutM: Record<string, number> = {
      charge: MOB_SIGNATURES.charge.widthM / 2 + PLAYER_HURT_RADIUS_M,
      maul: coneWorstM(MOB_SIGNATURES.maul.rangeM, MOB_SIGNATURES.maul.angleDeg) + PLAYER_HURT_RADIUS_M,
      slam: MOB_SIGNATURES.slam.radiusM,
      lunge: MOB_SIGNATURES.lunge.widthM / 2 + PLAYER_HURT_RADIUS_M,
      double_strike: coneWorstM(MOB_SIGNATURES.double_strike.rangeM, MOB_SIGNATURES.double_strike.angleDeg) + PLAYER_HURT_RADIUS_M,
      smoke_step: MOB_SIGNATURES.smoke_step.radiusM,
      swoop: coneWorstM(MOB_SIGNATURES.swoop.rangeM, MOB_SIGNATURES.swoop.angleDeg) + PLAYER_HURT_RADIUS_M,
      ground_blast: MOB_SIGNATURES.ground_blast.radiusM,
      volley: MOB_SIGNATURES.volley.widthM / 2 + PLAYER_HURT_RADIUS_M,
      tongue: MOB_SIGNATURES.tongue.widthM / 2 + PLAYER_HURT_RADIUS_M,
      pile_on_wave: coneWorstM(MOB_SIGNATURES.pile_on_wave.rangeM, MOB_SIGNATURES.pile_on_wave.angleDeg) + PLAYER_HURT_RADIUS_M
    };
    for (const signature of Object.values(MOB_SIGNATURES)) {
      const need = mobSignatureWalkOutMs(walkOutM[signature.kind]!, DEFAULT_PLAYER_SPEED_MPS) + MOB_ARCH_SIGNATURE_REACTION_SLACK_MS;
      // Every part is re-aimed at the player (double strike), so each one must be walkable on its own.
      for (const part of signature.telegraphMs) {
        expect(part, signature.kind).toBeGreaterThanOrEqual(MOB_ARCH_SIGNATURE_MIN_TELEGRAPH_MS);
        expect(part, signature.kind).toBeGreaterThanOrEqual(need);
      }
    }
    // Volley lanes leave a real gap beside the centre lane at the closest trigger distance.
    const v = MOB_SIGNATURES.volley;
    const sideOffsetM = v.triggerMinM * Math.sin(((v.angleDeg / 2) * Math.PI) / 180);
    expect(sideOffsetM - v.widthM, "gap between volley lanes at the nearest trigger").toBeGreaterThanOrEqual(15);
  });

  it("gives every melee archetype basic the 150 m effective reach the player's swing has on a typical mob", () => {
    expect(MOB_TACTICS_MELEE_REACH_M + MOB_TACTICS_MELEE_REACH_SLACK_M).toBe(150);
    expect(SWING_RANGE_M + mobHurtRadiusM("wolf")).toBeCloseTo(150, -1);
    for (const id of MOB_ARCHETYPE_IDS) {
      if (id === "caster") continue; // ranged basic keeps its own range
      expect(MOB_ARCHETYPE_PARAMS[id].basicReachM, id).toBe(MOB_TACTICS_MELEE_REACH_M);
    }
  });

  it("lets a reacting player WALK out of every basic strike cone (swing reach + body radius, 90 degrees; the swarm wave 70)", () => {
    for (const id of MOB_ARCHETYPE_IDS) {
      if (id === "caster") continue; // ranged aim lane: checked below
      const p = MOB_ARCHETYPE_PARAMS[id];
      const angle = id === "swarmer" ? MOB_SIGNATURES.pile_on_wave.angleDeg : 90;
      const need = mobSignatureWalkOutMs(coneWorstM(p.basicReachM + MOB_TACTICS_MELEE_REACH_SLACK_M, angle) + PLAYER_HURT_RADIUS_M, DEFAULT_PLAYER_SPEED_MPS) +
        MOB_ARCH_SIGNATURE_REACTION_SLACK_MS;
      expect(p.windupMs, id).toBeGreaterThanOrEqual(need);
    }
    // The ranged aim lane (40 m wide): half of it plus the hurt circle to leave.
    expect(MOB_ARCHETYPE_PARAMS.caster.windupMs).toBeGreaterThanOrEqual(
      mobSignatureWalkOutMs(MOB_RANGED_AIM_WIDTH_M / 2 + PLAYER_HURT_RADIUS_M, DEFAULT_PLAYER_SPEED_MPS) + MOB_ARCH_SIGNATURE_REACTION_SLACK_MS
    );
    // Phase 1 managed melee uses the same cone.
    expect(MOB_TACTICS_MELEE_WINDUP_MS).toBeGreaterThanOrEqual(
      mobSignatureWalkOutMs(coneWorstM(MOB_TACTICS_MELEE_REACH_M + MOB_TACTICS_MELEE_REACH_SLACK_M, 90) + PLAYER_HURT_RADIUS_M, DEFAULT_PLAYER_SPEED_MPS) +
        MOB_ARCH_SIGNATURE_REACTION_SLACK_MS
    );
  });

  it("keeps a signature hold under the token fail-safe, with 300 ms to spare, at every telegraph scale", () => {
    for (const scale of [1, 1.5, 2, 3]) {
      for (const signature of Object.values(MOB_SIGNATURES)) {
        const total = scaleMobSignature(signature, scale).telegraphMs.reduce((sum, ms) => sum + ms, 0) +
          MOB_ARCHETYPE_PARAMS[signature.archetype].recoverMs;
        expect(total, `${signature.kind} x${scale}`).toBeLessThanOrEqual(mobTacticsTokenMaxHoldMs(scale) - 300);
      }
      for (const id of MOB_ARCHETYPE_IDS) {
        const p = scaleMobArchetypeParams(MOB_ARCHETYPE_PARAMS[id], scale);
        expect(p.windupMs + p.recoverMs, `${id} x${scale}`).toBeLessThanOrEqual(mobTacticsTokenMaxHoldMs(scale) - 300);
      }
    }
  });

  it("spaces signature landings at or above the dash cooldown", () => {
    expect(MOB_ARCH_SIGNATURE_MIN_SPACING_MS).toBeGreaterThanOrEqual(DASH_COOLDOWN_MS);
  });
});

describe("mob archetype guardrails (computed from the tables)", () => {
  it("matches the tuned lone-mob rates and the Phase 1 baseline", () => {
    expect(MOB_ARCH_PHASE1_LONE_HE_PER_SEC).toBeCloseTo(0.714, 3);
    // Anchored to the tuned Phase 1 hold (450 + 300 ms), not the longer combat-feel windup.
    expect(MOB_ARCH_PHASE1_CEILING_HE_PER_SEC).toBeCloseTo(2.667, 3);
    // Telegraph time: longer cycles (Phase 3 retunes damage). Was brute 0.65, pack 0.71, skirmisher 0.7, caster 0.79, swarmer 0.7.
    const lone: Record<MobArchetypeId, number> = { brute: 0.566, pack: 0.571, skirmisher: 0.591, caster: 0.595, swarmer: 0.533 };
    for (const id of MOB_ARCHETYPE_IDS) expect(mobArchetypeLoneHePerSec(id), id).toBeCloseTo(lone[id], 2);
  });

  it("keeps the lone-mob rate between 0.85x and 1.3x of a Phase 1 managed mob (both on the telegraph-time windups)", () => {
    const phase1 = deriveMobRhythm(1_400, 100);
    const phase1LoneHePerSec = 1_000 / (phase1.windupMs + phase1.recoverMs + phase1.cooldownMs);
    for (const id of MOB_ARCHETYPE_IDS) {
      const ratio = mobArchetypeLoneHePerSec(id) / phase1LoneHePerSec;
      expect(ratio, id).toBeGreaterThanOrEqual(0.85);
      expect(ratio, id).toBeLessThanOrEqual(1.3);
    }
  });

  it("caps every pure pack at the governor: 1.25x the Phase 1 token ceiling", () => {
    const cap = MOB_ARCH_PHASE1_CEILING_HE_PER_SEC * MOB_ARCH_SIGNATURE_CEILING_MULTIPLIER;
    for (const id of MOB_ARCHETYPE_IDS) {
      for (const size of [1, 2, 4, 8, 16]) expect(mobArchetypePackHePerSec(id, size), `${id} x${size}`).toBeLessThanOrEqual(cap + 1e-9);
    }
  });

  it("gives casters two ranged points while archetypes are on", () => {
    expect(MOB_ARCH_CASTER_RANGED_TOKENS).toBe(2);
    expect(mobArchetypeCeilingHePerSec("caster")).toBeCloseTo((2 / 1.25) * 1.1, 2);
  });

  it("never lets a pure pack exceed the governor rate, at any size", () => {
    const governorRate = MOB_ARCH_GOVERNOR_BUDGET_HE / (MOB_ARCH_GOVERNOR_WINDOW_MS / 1_000);
    for (const id of MOB_ARCHETYPE_IDS) expect(mobArchetypePackHePerSec(id, 64), id).toBeLessThanOrEqual(governorRate + 1e-9);
  });

  it("keeps the signature ceiling and governor consistent with Phase 1", () => {
    const signatureCeiling = MOB_ARCH_PHASE1_CEILING_HE_PER_SEC * MOB_ARCH_SIGNATURE_CEILING_MULTIPLIER;
    expect(signatureCeiling).toBeCloseTo(3.33, 2);
    expect(MOB_ARCH_GOVERNOR_BUDGET_HE / (MOB_ARCH_GOVERNOR_WINDOW_MS / 1_000)).toBeCloseTo(signatureCeiling, 6);
    const maxFactor = Math.max(...Object.values(MOB_SIGNATURES).map((s) => s.damageFactor));
    expect(maxFactor / (MOB_ARCH_SIGNATURE_MIN_SPACING_MS / 1_000)).toBeLessThan(1.25);
  });

  it("makes the swarmer pay in melee points so it cannot stack on two other mobs", () => {
    expect(MOB_ARCHETYPE_PARAMS.swarmer.basicTokenCost).toBe(0.5);
    expect(MOB_TACTICS_MELEE_TOKENS / MOB_ARCHETYPE_PARAMS.swarmer.basicTokenCost).toBe(4);
  });
});
