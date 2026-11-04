import type { PhasedBossSpec } from "./phasedBossController.js";

/**
 * Drowned City bosses on the phased boss kit (docs/design/DROWNED_CITY_SPEC.md section 3). Each spec
 * id is also the boss definition's `controllerId`. Anchor ids name anchors of the boss room
 * (tools/appearance-studio/interior-specs/drowned_city.json).
 *
 * - The Watcher (west wing): four phases, each opening at its dais with a shielded wave of void
 *   creatures called onto the observatory's star points (K1 spawn anchors, K2 once per phase, K4
 *   retreat); a long narrow beam and a slam between waves.
 * - The Drowned Admiral (east wing): cutlass (cleave), harpoon (charge + cleave), anchor (big slam
 *   and two deckhands), enrage below 15%.
 * - Tidemaw and The Abyssal One are bespoke (tidemawBoss.ts, abyssalOneBoss.ts).
 */
const WATCHER_WAVE_ANCHORS = ["watcher_wave_n", "watcher_wave_s", "watcher_wave_w"] as const;

export const THE_WATCHER_SPEC: PhasedBossSpec = {
  id: "drowned_city_the_watcher",
  shieldedPhaseSuffix: "_shielded",
  castGapMs: 3_200,
  openingDelayMs: 1_000,
  enrage: { belowHealthPercent: 10, cooldownScale: 0.75, damageMultiplier: 1.25 },
  phases: [
    {
      id: "first_watch",
      untilHealthPercent: 75,
      retreatToAnchor: "watcher_dais",
      abilities: [
        { kind: "summon", key: "wave", abilityId: "watcher_void_wave", cooldownMs: 0, weight: 100, oncePerPhase: true, archetype: "drowned_cultist_dc", count: 3, shieldWhileAlive: true, spawnAnchors: WATCHER_WAVE_ANCHORS },
        { kind: "cleave", key: "beam", abilityId: "watcher_beam", cooldownMs: 6_000, weight: 3, rangeM: 420, angleDegrees: 14, telegraphMs: 1_400, damage: 24 },
        { kind: "slam", key: "slam", abilityId: "watcher_slam", cooldownMs: 9_000, weight: 1, initialDelayMs: 4_000, radiusM: 140, telegraphMs: 1_500, damage: 18 }
      ]
    },
    {
      id: "second_watch",
      untilHealthPercent: 50,
      retreatToAnchor: "watcher_dais",
      abilities: [
        { kind: "summon", key: "wave", abilityId: "watcher_void_wave", cooldownMs: 0, weight: 100, oncePerPhase: true, archetype: "void_wisp", count: 3, shieldWhileAlive: true, spawnAnchors: WATCHER_WAVE_ANCHORS },
        { kind: "cleave", key: "beam", abilityId: "watcher_beam", cooldownMs: 5_500, weight: 3, rangeM: 420, angleDegrees: 14, telegraphMs: 1_300, damage: 24 },
        { kind: "slam", key: "slam", abilityId: "watcher_slam", cooldownMs: 8_000, weight: 1, radiusM: 140, telegraphMs: 1_400, damage: 18 }
      ]
    },
    {
      id: "third_watch",
      untilHealthPercent: 25,
      retreatToAnchor: "watcher_dais",
      abilities: [
        { kind: "summon", key: "wave", abilityId: "watcher_void_wave", cooldownMs: 0, weight: 100, oncePerPhase: true, archetype: "deep_crawler", count: 3, shieldWhileAlive: true, spawnAnchors: WATCHER_WAVE_ANCHORS },
        { kind: "cleave", key: "beam", abilityId: "watcher_beam", cooldownMs: 5_000, weight: 3, rangeM: 420, angleDegrees: 16, telegraphMs: 1_200, damage: 26 },
        { kind: "slam", key: "slam", abilityId: "watcher_slam", cooldownMs: 7_500, weight: 1, radiusM: 150, telegraphMs: 1_300, damage: 18 }
      ]
    },
    {
      id: "last_watch",
      untilHealthPercent: 0,
      retreatToAnchor: "watcher_dais",
      abilities: [
        { kind: "summon", key: "wave", abilityId: "watcher_void_wave", cooldownMs: 0, weight: 100, oncePerPhase: true, archetype: "void_wisp", count: 4, shieldWhileAlive: true, spawnAnchors: WATCHER_WAVE_ANCHORS },
        { kind: "cleave", key: "beam", abilityId: "watcher_beam", cooldownMs: 4_500, weight: 3, rangeM: 420, angleDegrees: 18, telegraphMs: 1_100, damage: 28 },
        { kind: "slam", key: "slam", abilityId: "watcher_slam", cooldownMs: 7_000, weight: 2, radiusM: 160, telegraphMs: 1_200, damage: 20 }
      ]
    }
  ]
};

export const DROWNED_ADMIRAL_SPEC: PhasedBossSpec = {
  id: "drowned_city_drowned_admiral",
  castGapMs: 3_200,
  openingDelayMs: 1_500,
  enrage: { belowHealthPercent: 15, cooldownScale: 0.7, damageMultiplier: 1.3 },
  phases: [
    {
      id: "cutlass",
      untilHealthPercent: 66,
      abilities: [
        { kind: "cleave", key: "cutlass_sweep", abilityId: "admiral_cutlass_sweep", cooldownMs: 4_500, weight: 3, rangeM: 120, angleDegrees: 100, telegraphMs: 1_200, damage: 22 },
        { kind: "cleave", key: "riposte", abilityId: "admiral_riposte", cooldownMs: 7_000, weight: 1, initialDelayMs: 3_000, rangeM: 150, angleDegrees: 40, telegraphMs: 900, damage: 20 }
      ]
    },
    {
      id: "harpoon",
      untilHealthPercent: 33,
      abilities: [
        { kind: "charge", key: "harpoon_lunge", abilityId: "admiral_harpoon_lunge", cooldownMs: 8_000, weight: 3, lengthM: 480, widthM: 80, telegraphMs: 1_300, damage: 26 },
        { kind: "cleave", key: "harpoon_sweep", abilityId: "admiral_harpoon_sweep", cooldownMs: 5_000, weight: 2, rangeM: 170, angleDegrees: 60, telegraphMs: 1_100, damage: 22 }
      ]
    },
    {
      id: "anchor",
      untilHealthPercent: 0,
      abilities: [
        { kind: "slam", key: "anchor_drop", abilityId: "admiral_anchor_drop", cooldownMs: 8_000, weight: 3, radiusM: 230, telegraphMs: 1_800, damage: 30 },
        { kind: "summon", key: "all_hands", abilityId: "admiral_all_hands", cooldownMs: 30_000, weight: 3, initialDelayMs: 2_000, archetype: "drowned_deckhand_dc", count: 2 },
        { kind: "cleave", key: "anchor_swing", abilityId: "admiral_anchor_swing", cooldownMs: 5_000, weight: 2, rangeM: 140, angleDegrees: 120, telegraphMs: 1_200, damage: 24 }
      ]
    }
  ]
};

export const DROWNED_CITY_BOSS_SPECS: readonly PhasedBossSpec[] = Object.freeze([
  THE_WATCHER_SPEC,
  DROWNED_ADMIRAL_SPEC
]);
