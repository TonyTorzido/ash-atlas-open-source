import { SPECIALIZATION_IDS } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { CLASS_SPRITES, classIconProps } from "./ClassIcons.js";

describe("ClassIcons", () => {
  it("maps every class in supplied page order to one unique in-bounds atlas cell", () => {
    // Ronin has no art yet and reuses the Ninja cell (checked below); every other class owns one cell.
    expect(CLASS_SPRITES.ronin).toMatchObject({ x: CLASS_SPRITES.ninja.x, y: CLASS_SPRITES.ninja.y, key: "ronin" });
    const entries = Object.entries(CLASS_SPRITES).filter(([id]) => id !== "ronin");
    // Atlas cells 3 and 11 are retired and stay empty.
    const atlasOrder = [
      "warrior", "knight", "legionnaire", null,
      "ranger", "mercenary", "sentinel", "assassin",
      "ninja", "monk", "rogue", null,
      "druid", "merchant", "artificer", "voyager",
    ];
    expect(entries.map(([id]) => id)).toEqual(atlasOrder.filter((id) => id !== null));
    expect(Object.keys(CLASS_SPRITES)).toEqual(expect.arrayContaining([...SPECIALIZATION_IDS]));

    const occupied = new Set<string>();
    entries.forEach(([id, sprite]) => {
      const index = atlasOrder.indexOf(id);
      expect(sprite).toMatchObject({
        src: "/assets/skills/class-icons-v3.png",
        x: (index % 4) * 256,
        y: Math.floor(index / 4) * 256,
        width: 256,
        height: 256,
        key: id,
      });
      expect(sprite.x + sprite.width).toBeLessThanOrEqual(1024);
      expect(sprite.y + sprite.height).toBeLessThanOrEqual(1024);
      const cell = `${sprite.x},${sprite.y},${sprite.width},${sprite.height}`;
      expect(occupied.has(cell)).toBe(false);
      occupied.add(cell);
    });
  });

  it("always returns the mapped class sprite", () => {
    for (const id of SPECIALIZATION_IDS) {
      expect(classIconProps(id)).toEqual({ iconKey: id, sprite: CLASS_SPRITES[id] });
    }
  });
});
