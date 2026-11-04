import { describe, expect, it } from "vitest";
import { MOB_SIGNATURES, MOB_SPAWN_KINDS, mobArchetypeAssignment } from "@ash-atlas/shared";

import {
  ANIMAL_GIMMICKS,
  BANDIT_BACKSTAB,
  BEAR_MAUL,
  FROG_TONGUE,
  OGRE_SLAM,
  SWOOP,
  gimmickStrikeFor
} from "./mobGimmicks.js";
import { HOG_CHARGE, HOG_CHARGE_ANIMAL } from "./mobSpecialBehaviors.js";

describe("shared archetype signatures match the existing gimmicks", () => {
  it("copies the existing numbers", () => {
    // The maul factor was retuned (design rule 7, 1.8 / 1.3 -> 2.6); the legacy gimmick keeps its numbers.
    expect(MOB_SIGNATURES.maul.damageFactor).toBeGreaterThan(BEAR_MAUL.damageFactor);
    // The animal maul factor was retuned (design rule 7, 1.3 -> 1.8); the legacy gimmick keeps 1.3.
    expect(MOB_SIGNATURES.maul.damageFactorAnimal).toBeGreaterThan(ANIMAL_GIMMICKS.bearMaulDamageFactor);
    expect(MOB_SIGNATURES.maul.rangeM).toBe(BEAR_MAUL.rangeM);
    expect(MOB_SIGNATURES.maul.angleDeg).toBe(BEAR_MAUL.angleDegrees);
    expect(MOB_SIGNATURES.maul.triggerMaxM).toBe(BEAR_MAUL.triggerRangeM);
    expect(MOB_SIGNATURES.slam.damageFactor).toBe(OGRE_SLAM.damageFactor);
    expect(MOB_SIGNATURES.slam.radiusM).toBe(OGRE_SLAM.radiusM);
    expect(MOB_SIGNATURES.slam.triggerMaxM).toBe(OGRE_SLAM.triggerRangeM);
    expect(MOB_SIGNATURES.charge.damageFactor).toBe(HOG_CHARGE.damageFactor);
    expect(MOB_SIGNATURES.charge.damageFactorAnimal).toBe(HOG_CHARGE_ANIMAL.damageFactor);
    expect(MOB_SIGNATURES.charge.triggerMinM).toBe(HOG_CHARGE.minRangeM);
    expect(MOB_SIGNATURES.charge.widthM).toBe(HOG_CHARGE.widthM * 2);
    expect(MOB_SIGNATURES.swoop.damageFactor).toBe(SWOOP.damageFactor);
    expect(MOB_SIGNATURES.swoop.rangeM).toBe(SWOOP.rangeM);
    expect(MOB_SIGNATURES.swoop.angleDeg).toBe(SWOOP.angleDegrees);
    expect(MOB_SIGNATURES.smoke_step.damageFactor).toBe(BANDIT_BACKSTAB.damageFactor);
    expect(MOB_SIGNATURES.smoke_step.radiusM).toBe(BANDIT_BACKSTAB.puffRadiusM);
    expect(MOB_SIGNATURES.smoke_step.cooldownMs).toBe(BANDIT_BACKSTAB.intervalMs);
    // Telegraph time: managed telegraphs are at least the legacy ones (the gimmick keeps its own timing, flag off).
    expect(MOB_SIGNATURES.smoke_step.telegraphMs[0]).toBeGreaterThanOrEqual(BANDIT_BACKSTAB.delayMs);
    expect(MOB_SIGNATURES.tongue.damageFactor).toBe(FROG_TONGUE.damageFactor);
    expect(MOB_SIGNATURES.tongue.widthM).toBe(FROG_TONGUE.widthM);
    expect(MOB_SIGNATURES.tongue.triggerMinM).toBe(FROG_TONGUE.minRangeM);
    expect(MOB_SIGNATURES.tongue.triggerMaxM).toBe(FROG_TONGUE.maxRangeM);
    expect(MOB_SIGNATURES.tongue.telegraphMs[0]).toBeGreaterThanOrEqual(FROG_TONGUE.delayMs);
  });

  it("agrees with which mobs already run a legacy strike", () => {
    const strikeToSignature: Record<string, string> = {
      slam: "slam", maul: "maul", pull: "tongue", smoke: "smoke_step", swoop: "swoop", ink: "ground_blast"
    };
    // Frog-template swarmers keep no tongue under archetypes: their signature is the wave (spec section 3, Swarmer).
    const loseLegacyStrike: string[] = [];
    for (const kind of MOB_SPAWN_KINDS) {
      const legacy = gimmickStrikeFor(kind);
      const assignment = mobArchetypeAssignment(kind);
      if (!legacy || !assignment) continue;
      if (assignment.signature === strikeToSignature[legacy.kind]) continue;
      loseLegacyStrike.push(kind);
    }
    expect(loseLegacyStrike.sort()).toEqual(["frogfolk_tadpole", "river_salmon", "sea_otter"]);
  });
});
