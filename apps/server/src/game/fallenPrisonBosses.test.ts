import { describe, expect, it } from "vitest";
import { DUNGEON_BOSS_DEFINITIONS, MOB_ARCHETYPE_KEYS } from "@ash-atlas/shared";

import { FALLEN_PRISON_BOSS_SPECS, TRIFANG_WARDEN_SPEC } from "./fallenPrisonBosses.js";
import { validatePhasedBossSpec } from "./phasedBossController.js";

describe("Fallen Prison phased bosses", () => {
  it("has valid specs, each selected by a boss definition", () => {
    for (const spec of FALLEN_PRISON_BOSS_SPECS) {
      expect(() => validatePhasedBossSpec(spec)).not.toThrow();
      expect(DUNGEON_BOSS_DEFINITIONS.some((definition) => definition.controllerId === spec.id)).toBe(true);
      for (const phase of spec.phases) {
        for (const ability of phase.abilities) {
          if (ability.kind === "summon") expect(MOB_ARCHETYPE_KEYS).toContain(ability.archetype);
        }
      }
    }
  });

  it("gives the warden three heads that fall in order, each with its own special", () => {
    expect(TRIFANG_WARDEN_SPEC.phases.map((phase) => phase.untilHealthPercent)).toEqual([66, 33, 0]);
    const specials = TRIFANG_WARDEN_SPEC.phases.map((phase) => phase.abilities[0]!.key);
    expect(new Set(specials).size).toBe(3);
  });
});
