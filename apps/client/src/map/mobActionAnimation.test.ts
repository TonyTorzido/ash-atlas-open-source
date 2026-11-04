import { MOB_SIGNATURES } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { mobActionProgramForAbility } from "./mobActionAnimation.js";

describe("mobActionProgramForAbility", () => {
  it("keeps the existing ids", () => {
    expect(mobActionProgramForAbility("hog_charge")).toBe("charge");
    expect(mobActionProgramForAbility("ogre_slam")).toBe("slam");
    expect(mobActionProgramForAbility("melee_windup")).toBeNull();
  });

  it("maps the archetype signature ids that have a pose", () => {
    for (const id of MOB_SIGNATURES.charge.abilityIds) expect(mobActionProgramForAbility(id)).toBe("charge");
    for (const id of MOB_SIGNATURES.maul.abilityIds) expect(mobActionProgramForAbility(id)).toBe("maul");
    for (const id of MOB_SIGNATURES.slam.abilityIds) expect(mobActionProgramForAbility(id)).toBe("slam");
    for (const id of MOB_SIGNATURES.swoop.abilityIds) expect(mobActionProgramForAbility(id)).toBe("swoop");
    for (const id of MOB_SIGNATURES.smoke_step.abilityIds) expect(mobActionProgramForAbility(id)).toBe("blink");
    for (const id of MOB_SIGNATURES.lunge.abilityIds) expect(mobActionProgramForAbility(id)).toBe("charge");
    for (const id of MOB_SIGNATURES.double_strike.abilityIds) expect(mobActionProgramForAbility(id)).toBe("maul");
    for (const id of MOB_SIGNATURES.ground_blast.abilityIds) expect(mobActionProgramForAbility(id)).toBe("howl");
    for (const id of MOB_SIGNATURES.volley.abilityIds) expect(mobActionProgramForAbility(id)).toBe("howl");
    expect(mobActionProgramForAbility("caster_volley_x")).toBeNull();
  });
});
