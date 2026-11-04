import { PROFESSION_IDS, TRADE_SKILL_IDS } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  PROFESSION_SKILL_SPRITES,
  PROFESSION_SPRITES,
  professionIconProps,
  professionSkillIconProps,
} from "./ProfessionIcons.js";

describe("ProfessionIcons", () => {
  it("maps every live profession in supplied page order to one unique in-bounds atlas cell", () => {
    const entries = Object.entries(PROFESSION_SPRITES);
    expect(entries.map(([id]) => id)).toEqual([
      "woodcutter", "miner", "oil_worker", "builder", "metallurgy",
    ]);
    expect(entries.map(([id]) => id)).toEqual(expect.arrayContaining([...PROFESSION_IDS]));
    // Retired Hunter (cell 2) and Breeder (cell 5) keep their atlas cells, unused.
    const atlasOrder = ["woodcutter", "miner", "hunter", "oil_worker", "builder", "breeder", "metallurgy"];

    const occupied = new Set<string>();
    entries.forEach(([id, sprite]) => {
      const cellIndex = atlasOrder.indexOf(id);
      expect(sprite).toMatchObject({
        src: "/assets/skills/profession-icons-v3.png",
        x: (cellIndex % 3) * 256,
        y: Math.floor(cellIndex / 3) * 256,
        width: 256,
        height: 256,
        key: id,
      });
      expect(sprite.x + sprite.width).toBeLessThanOrEqual(768);
      expect(sprite.y + sprite.height).toBeLessThanOrEqual(768);
      const cell = `${sprite.src},${sprite.x},${sprite.y},${sprite.width},${sprite.height}`;
      expect(occupied.has(cell)).toBe(false);
      occupied.add(cell);
    });
  });

  it("always returns the mapped profession sprite", () => {
    for (const id of PROFESSION_IDS) {
      expect(professionIconProps(id)).toEqual({ iconKey: id, sprite: PROFESSION_SPRITES[id] });
    }
  });

  it("maps every planned profession in supplied page order to one unique in-bounds atlas cell", () => {
    const entries = Object.entries(PROFESSION_SKILL_SPRITES);
    expect(entries.map(([id]) => id)).toEqual([
      "blacksmithing", "leatherworking", "alchemy", "cartography", "tradecraft",
    ]);
    expect(entries.map(([id]) => id).sort()).toEqual([...TRADE_SKILL_IDS].sort());
    // The duplicate profession-skill Metallurgy merged into the Metallurgy profession; cell 3 stays unused.
    const atlasOrder = ["blacksmithing", "leatherworking", "alchemy", "metallurgy", "cartography", "tradecraft"];

    const occupied = new Set<string>();
    entries.forEach(([id, sprite]) => {
      const index = atlasOrder.indexOf(id);
      expect(sprite).toMatchObject({
        src: "/assets/skills/profession-skill-icons-v3.png",
        x: (index % 3) * 256,
        y: Math.floor(index / 3) * 256,
        width: 256,
        height: 256,
        key: id,
      });
      expect(sprite.x + sprite.width).toBeLessThanOrEqual(768);
      expect(sprite.y + sprite.height).toBeLessThanOrEqual(512);
      const cell = `${sprite.x},${sprite.y},${sprite.width},${sprite.height}`;
      expect(occupied.has(cell)).toBe(false);
      occupied.add(cell);
    });
  });

  it("always returns the mapped planned profession sprite", () => {
    for (const id of TRADE_SKILL_IDS) {
      expect(professionSkillIconProps(id)).toEqual({ iconKey: id, sprite: PROFESSION_SKILL_SPRITES[id] });
    }
  });
});
