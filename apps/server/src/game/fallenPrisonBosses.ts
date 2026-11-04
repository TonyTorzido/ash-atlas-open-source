import type { PhasedBossSpec } from "./phasedBossController.js";

/**
 * Fallen Prison bosses, built on the phased boss kit. Each spec id is also the boss definition's
 * `controllerId`. Health gates stand in for the mechanics the design calls for:
 * - The Cohort Marshal: formation, then a shield wall (invulnerable while the legionaries live), then a charge.
 * - The Brood Matron: hatchlings spill from the eggs, then a shielded brood, then a venom rage.
 * - The Trifang Warden: three heads, each its own phase and special, killed strictly in order
 *   (the thresholds are the heads' shares of the health pool).
 */
export const CENTURION_SPEC: PhasedBossSpec = {
  id: "fallen_prison_centurion",
  castGapMs: 3_500,
  openingDelayMs: 1_500,
  enrage: { belowHealthPercent: 15, cooldownScale: 0.75, damageMultiplier: 1.25 },
  phases: [
    {
      id: "formation",
      untilHealthPercent: 65,
      abilities: [
        { kind: "cleave", key: "shield_bash", abilityId: "centurion_shield_bash", cooldownMs: 5_000, weight: 3, rangeM: 110, angleDegrees: 80, telegraphMs: 1_200, damage: 18 },
        { kind: "slam", key: "stomp", abilityId: "centurion_stomp", cooldownMs: 10_000, weight: 1, initialDelayMs: 5_000, radiusM: 130, telegraphMs: 1_500, damage: 14 },
        { kind: "summon", key: "reinforce", abilityId: "centurion_reinforce", cooldownMs: 28_000, weight: 3, initialDelayMs: 8_000, archetype: "warden_scout", count: 2 }
      ]
    },
    {
      id: "shield_wall",
      untilHealthPercent: 30,
      abilities: [
        { kind: "summon", key: "testudo", abilityId: "centurion_testudo", cooldownMs: 30_000, weight: 5, archetype: "legion_soldier", count: 2, shieldWhileAlive: true },
        { kind: "cleave", key: "shield_bash", abilityId: "centurion_shield_bash", cooldownMs: 5_000, weight: 2, rangeM: 110, angleDegrees: 80, telegraphMs: 1_100, damage: 18 },
        { kind: "slam", key: "stomp", abilityId: "centurion_stomp", cooldownMs: 9_000, weight: 1, radiusM: 130, telegraphMs: 1_400, damage: 14 }
      ]
    },
    {
      id: "last_charge",
      untilHealthPercent: 0,
      abilities: [
        { kind: "charge", key: "charge", abilityId: "centurion_charge", cooldownMs: 9_000, weight: 3, lengthM: 450, widthM: 80, telegraphMs: 1_300, damage: 22 },
        { kind: "cleave", key: "shield_bash", abilityId: "centurion_shield_bash", cooldownMs: 4_500, weight: 2, rangeM: 110, angleDegrees: 80, telegraphMs: 1_000, damage: 18 },
        { kind: "slam", key: "stomp", abilityId: "centurion_stomp", cooldownMs: 8_000, weight: 1, radiusM: 130, telegraphMs: 1_300, damage: 14 }
      ]
    }
  ]
};

export const BROOD_MATRON_SPEC: PhasedBossSpec = {
  id: "fallen_prison_brood_matron",
  castGapMs: 3_500,
  openingDelayMs: 2_000,
  enrage: { belowHealthPercent: 15, cooldownScale: 0.7, damageMultiplier: 1.3 },
  phases: [
    {
      id: "brooding",
      untilHealthPercent: 65,
      abilities: [
        { kind: "slam", key: "coil_slam", abilityId: "brood_matron_coil_slam", cooldownMs: 8_000, weight: 2, radiusM: 150, telegraphMs: 1_500, damage: 18 },
        { kind: "summon", key: "hatch", abilityId: "brood_matron_hatch", cooldownMs: 22_000, weight: 4, initialDelayMs: 3_000, archetype: "coil_hatchling", count: 3 },
        { kind: "cleave", key: "venom_spit", abilityId: "brood_matron_venom_spit", cooldownMs: 5_500, weight: 2, rangeM: 140, angleDegrees: 60, telegraphMs: 1_300, damage: 20 }
      ]
    },
    {
      id: "swarm",
      untilHealthPercent: 30,
      abilities: [
        { kind: "summon", key: "brood", abilityId: "brood_matron_brood", cooldownMs: 26_000, weight: 5, archetype: "coil_hatchling", count: 4, shieldWhileAlive: true },
        { kind: "slam", key: "coil_slam", abilityId: "brood_matron_coil_slam", cooldownMs: 8_000, weight: 2, radiusM: 150, telegraphMs: 1_400, damage: 18 },
        { kind: "cleave", key: "venom_spit", abilityId: "brood_matron_venom_spit", cooldownMs: 5_000, weight: 2, rangeM: 140, angleDegrees: 60, telegraphMs: 1_200, damage: 20 }
      ]
    },
    {
      id: "wrath",
      untilHealthPercent: 0,
      abilities: [
        { kind: "charge", key: "lunge", abilityId: "brood_matron_lunge", cooldownMs: 9_000, weight: 2, lengthM: 420, widthM: 90, telegraphMs: 1_300, damage: 24 },
        { kind: "slam", key: "coil_slam", abilityId: "brood_matron_coil_slam", cooldownMs: 7_000, weight: 2, radiusM: 170, telegraphMs: 1_300, damage: 18 },
        { kind: "cleave", key: "venom_spit", abilityId: "brood_matron_venom_spit", cooldownMs: 4_500, weight: 2, rangeM: 140, angleDegrees: 60, telegraphMs: 1_100, damage: 20 }
      ]
    }
  ]
};

export const TRIFANG_WARDEN_SPEC: PhasedBossSpec = {
  id: "fallen_prison_trifang_warden",
  castGapMs: 3_200,
  openingDelayMs: 2_000,
  enrage: { belowHealthPercent: 10, cooldownScale: 0.7, damageMultiplier: 1.3 },
  phases: [
    {
      // Head one: a wide cone of flame.
      id: "head_flame",
      untilHealthPercent: 66,
      abilities: [
        { kind: "cleave", key: "flame_breath", abilityId: "warden_flame_breath", cooldownMs: 5_000, weight: 3, rangeM: 150, angleDegrees: 110, telegraphMs: 1_500, damage: 22 },
        { kind: "slam", key: "ember_burst", abilityId: "warden_ember_burst", cooldownMs: 10_000, weight: 1, initialDelayMs: 4_000, radiusM: 140, telegraphMs: 1_500, damage: 16 }
      ]
    },
    {
      // Head two: a rushing bite down a line.
      id: "head_fang",
      untilHealthPercent: 33,
      abilities: [
        { kind: "charge", key: "fang_rush", abilityId: "warden_fang_rush", cooldownMs: 8_000, weight: 3, lengthM: 450, widthM: 80, telegraphMs: 1_300, damage: 24 },
        { kind: "cleave", key: "snap", abilityId: "warden_snap", cooldownMs: 5_000, weight: 2, rangeM: 110, angleDegrees: 70, telegraphMs: 1_100, damage: 20 }
      ]
    },
    {
      // Head three: a howl that shakes the arena and calls the guards.
      id: "head_howl",
      untilHealthPercent: 0,
      abilities: [
        { kind: "slam", key: "howl", abilityId: "warden_howl", cooldownMs: 8_000, weight: 3, radiusM: 220, telegraphMs: 2_000, damage: 24 },
        { kind: "summon", key: "call_guards", abilityId: "warden_call_guards", cooldownMs: 30_000, weight: 3, initialDelayMs: 6_000, archetype: "warden_scout", count: 2 },
        { kind: "cleave", key: "snap", abilityId: "warden_snap", cooldownMs: 4_500, weight: 1, rangeM: 110, angleDegrees: 70, telegraphMs: 1_000, damage: 20 }
      ]
    }
  ]
};

export const FALLEN_PRISON_BOSS_SPECS: readonly PhasedBossSpec[] = Object.freeze([
  CENTURION_SPEC,
  BROOD_MATRON_SPEC,
  TRIFANG_WARDEN_SPEC
]);
