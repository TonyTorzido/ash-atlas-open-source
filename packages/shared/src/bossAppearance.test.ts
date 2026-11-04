import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  bossAppearanceAssetKeys,
  bossAppearanceForArchetype,
  bossOverallScale,
  parseBossAppearanceCatalog,
  resolveBossWeaponTransform
} from "./index.js";

describe("boss appearance catalog", () => {
  it("designates Xoral and resolves Ready and Attack from the Idle weapon pose", () => {
    const catalog = structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    const xoral = catalog.bosses[0]!;
    xoral.weapon.assetKey = "xoral/weapons/blade.png";
    xoral.weapon.placements.idle = { offsetX: 4, offsetY: -8, pivotX: 0.2 };
    xoral.weapon.placements.combat_ready = { rotationDegrees: -30 };
    xoral.weapon.placements.attack_action = { offsetX: 16, rotationDegrees: 75 };

    expect(bossAppearanceForArchetype(catalog, "xoral")?.bossId).toBe("xoral");
    expect(bossOverallScale(catalog, "xoral")).toBe(1);
    expect(resolveBossWeaponTransform(catalog, "xoral", "combat_ready")).toMatchObject({
      offsetX: 4,
      offsetY: -8,
      pivotX: 0.2,
      rotationDegrees: -30
    });
    expect(resolveBossWeaponTransform(catalog, "xoral", "attack_action")).toMatchObject({
      offsetX: 16,
      offsetY: -8,
      rotationDegrees: 75
    });
    expect(bossAppearanceAssetKeys(catalog)).toEqual([
      "xoral/body.png",
      "xoral/weapons/blade.png",
      "sewer-rat-miniboss.png",
      "brood-matriarch.png",
      "raptor-chieftain.png",
      "thunderwing.png",
      "hollow-elder.png",
      "grandmaster.png",
      "elder-dragon.png"
    ]);
  });

  it("rejects duplicate official archetypes and unsafe asset paths", () => {
    const duplicate = structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    duplicate.bosses.push({ ...structuredClone(duplicate.bosses[0]!), bossId: "other" });
    expect(() => parseBossAppearanceCatalog(duplicate)).toThrow(/duplicate boss archetype/u);

    const unsafe = structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    unsafe.bosses[0]!.bodyAssetKey = "../xoral.png";
    expect(() => parseBossAppearanceCatalog(unsafe)).toThrow(/normalized relative PNG/u);

    const oversized = structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    oversized.bosses[0]!.overallScale = 21;
    expect(() => parseBossAppearanceCatalog(oversized)).toThrow();
  });

  it("applies the canonical world-object zoom policy to the designated boss", () => {
    expect(DEFAULT_BOSS_APPEARANCE_CATALOG.catalogRevision).toBe(8);
    const presentation = DEFAULT_BOSS_APPEARANCE_CATALOG.bosses[0]!.presentation;
    expect(presentation.zoomStrength).toBe(0.70389327891398);
    expect(presentation.minHeightPx).toBeCloseTo(presentation.baseHeightPx * 0.25);
    expect(presentation.maxHeightPx).toBeNull();

    const capped = structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    capped.bosses[0] = {
      ...capped.bosses[0]!,
      presentation: {
        ...capped.bosses[0]!.presentation,
        maxHeightPx: presentation.baseHeightPx * 1.1
      }
    };
    expect(() => parseBossAppearanceCatalog(capped)).toThrow(
      /Boss maximum height must follow the world-object zoom policy/u
    );
  });
});
