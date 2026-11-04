import { GENERAL_SKILL_IDS, PROGRESSION_ICON_PRESENTATION_CATALOG, TRADE_SKILL_IDS, isTradeSkillId } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { GENERAL_SKILL_SPRITES, generalSkillIconProps } from "./GeneralSkillIcons.js";

describe("GeneralSkillIcons", () => {
  it("maps every General Skill in supplied page order to one unique in-bounds atlas cell", () => {
    const entries = Object.entries(GENERAL_SKILL_SPRITES).filter(([id]) => !isTradeSkillId(id));
    // The trade skills draw from the profession-skill atlas instead.
    for (const id of TRADE_SKILL_IDS) expect(GENERAL_SKILL_SPRITES[id].src).toBe("/assets/skills/profession-skill-icons-v3.png");
    expect(entries.map(([id]) => id)).toEqual([
      "cleave", "shield_charge", "provoke", "pursuit", "pierce_armor",
      "blight_strike", "second_wind", "deathburst", "archery", "ricochet",
      "quarry_sense", "huntsmans_edge", "concentration", "martial_arts", "perfect_strike",
      "tactics", "taunt", "war_standard", "heroism", "cleanse",
      "calm_mind", "scavenge", "companion_bond", "delvers_lore",
    ]);
    expect(Object.keys(GENERAL_SKILL_SPRITES)).toEqual(expect.arrayContaining([...GENERAL_SKILL_IDS]));

    const occupied = new Set<string>();
    entries.forEach(([id, sprite], index) => {
      expect(sprite).toMatchObject({
        src: "/assets/skills/general-skills-v3.png",
        x: (index % 5) * 256,
        y: Math.floor(index / 5) * 256,
        width: 256,
        height: 256,
        key: id,
      });
      expect(sprite.x).toBeGreaterThanOrEqual(0);
      expect(sprite.y).toBeGreaterThanOrEqual(0);
      expect(sprite.x + sprite.width).toBeLessThanOrEqual(1280);
      expect(sprite.y + sprite.height).toBeLessThanOrEqual(1280);
      const cell = `${sprite.x},${sprite.y},${sprite.width},${sprite.height}`;
      expect(occupied.has(cell)).toBe(false);
      occupied.add(cell);
    });
  });

  it("uses the supplied sprite for dependency-hidden Provoke", () => {
    expect(generalSkillIconProps("provoke")).toEqual({
      iconKey: "provoke",
      sprite: GENERAL_SKILL_SPRITES.provoke,
    });
  });

  it("propagates the shared presentation transform into game sprites", () => {
    expect(GENERAL_SKILL_SPRITES.cleave).toMatchObject(
      PROGRESSION_ICON_PRESENTATION_CATALOG.transforms["general:cleave"]!
    );
  });
});
