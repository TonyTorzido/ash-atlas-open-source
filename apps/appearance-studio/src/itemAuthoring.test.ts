import type { PLAYER_AUTHORING_LAYER_IDS } from "@ash-atlas/shared";
import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  EQUIPMENT_GAMEPLAY_FAMILIES,
  ITEM_VARIANT_CATALOG,
  PLAYER_AUTHORING_RENDER_LAYER,
  appearanceCategory,
  appearanceAuthoringLayer,
  resolveAppearancePlacement
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  createItemVariantDraft,
  createPlayerOverlayAppearanceDraft,
  createStyleAppearanceDraft,
  familyForCategory,
  familyForEquipment,
  saveFamilyPosePreset,
  setFamilyPlayerOverlaySlot,
  updateExistingItemAppearance
} from "./itemAuthoring.js";

describe("Appearance Studio item authoring", () => {
  it("creates an item variant linked to family gameplay and appearance data", () => {
    const draft = createItemVariantDraft({
      catalog: structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG),
      itemVariants: structuredClone(ITEM_VARIANT_CATALOG),
      definitionId: "ember_sword",
      displayName: "Ember Sword",
      familyId: "sword",
      assetKey: "weapons/ember-sword.png",
      authoringLayer: "primary_weapon"
    });

    expect(draft.itemVariants.variants.at(-1)).toEqual({
      definitionId: "ember_sword",
      displayName: "Ember Sword",
      familyId: "sword",
      role: "cosmetic",
      appearanceId: "ember_sword"
    });
    expect(draft.appearance).toMatchObject({
      appearanceId: "ember_sword",
      cosmetic: false,
      compatibleEquipmentDefinitionIds: ["starter_sword"]
    });
    expect(resolveAppearancePlacement(
      draft.catalog,
      "ember_sword",
      "idle"
    )).toMatchObject({
      anchorId: "left_hand",
      layer: "front_hand"
    });
  });

  it("updates an existing item asset without losing its pose-specific placement", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const original = catalog.appearances.find(
      ({ equipmentDefinitionId }) => equipmentDefinitionId === "starter_sword"
    )!;
    const updated = updateExistingItemAppearance({
      catalog,
      itemVariants: ITEM_VARIANT_CATALOG,
      definitionId: "starter_sword",
      assetKey: "weapons/revised-starter-sword.png"
    });

    expect(updated.appearance.assetKey).toBe("weapons/revised-starter-sword.png");
    expect(updated.appearance.placements).toEqual(original.placements);
    expect(catalog.appearances.find(
      ({ appearanceId }) => appearanceId === original.appearanceId
    )?.assetKey).toBe(original.assetKey);
  });

  it("uses editable family/pose presets and maps all simplified layers to renderer defaults", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const sword = catalog.appearances.find(
      ({ equipmentDefinitionId }) => equipmentDefinitionId === "starter_sword"
    )!;
    const ready = resolveAppearancePlacement(catalog, sword.appearanceId, "combat_ready");
    const preset = saveFamilyPosePreset(
      catalog,
      sword.familyId,
      "combat_ready",
      { ...ready, offsetX: -27, rotationDegrees: 33 }
    );
    expect(resolveAppearancePlacement(
      preset,
      sword.appearanceId,
      "combat_ready"
    )).toEqual(ready);

    const fresh = createItemVariantDraft({
      catalog: preset,
      itemVariants: ITEM_VARIANT_CATALOG,
      definitionId: "preset_sword",
      displayName: "Preset Sword",
      familyId: "sword",
      assetKey: "weapons/preset-sword.png"
    });
    expect(resolveAppearancePlacement(
      fresh.catalog,
      fresh.appearance.appearanceId,
      "combat_ready"
    )).toMatchObject({ offsetX: -27, rotationDegrees: 33 });

    expect(PLAYER_AUTHORING_RENDER_LAYER).toEqual({
      hair: "hair",
      eyes: "eyes",
      nose_mouth: "nose_mouth",
      face: "eyes",
      mask: "mask",
      body: "chest_armor",
      chest: "chest_armor",
      boots: "boots",
      feet: "feet",
      gloves: "gloves",
      hands: "hands",
      legs: "legs",
      primary_weapon: "front_hand",
      shield: "shield"
    });
    const authoredLayers = new Set(catalog.families.map(({ authoringLayer }) => authoringLayer));
    for (const layer of [
      "hair", "eyes", "mask", "body", "boots", "gloves",
      "primary_weapon", "shield", "legs"
    ] satisfies typeof PLAYER_AUTHORING_LAYER_IDS[number][]) {
      expect(authoredLayers.has(layer)).toBe(true);
    }
    expect(appearanceAuthoringLayer(catalog, sword.appearanceId))
      .toBe("primary_weapon");
    expect(catalog.families.find(({ familyId }) => familyId === "shield")
      ?.placements.idle.anchorId).toBe("right_hand");
  });

  it("updates gear overlay metadata and canonical placement without gameplay changes", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const updated = setFamilyPlayerOverlaySlot(catalog, "gloves", "feet");
    expect(updated.families.find(({ familyId }) => familyId === "gloves"))
      .toMatchObject({
        playerOverlaySlot: "feet",
        placements: { idle: { anchorId: "left_foot", layer: "feet" } }
      });
    expect(setFamilyPlayerOverlaySlot(updated, "one_handed_sword", null).families.find(
      ({ familyId }) => familyId === "one_handed_sword"
    )?.playerOverlaySlot).toBeNull();
  });

  it("keeps every current visual gear family authorable", () => {
    const catalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    const visualFamilies = Object.values(EQUIPMENT_GAMEPLAY_FAMILIES).filter((family) =>
      family.category !== "ring"
    );
    for (const family of visualFamilies) {
      expect(() => familyForEquipment(catalog, family.familyId)).not.toThrow();
    }
    expect(familyForEquipment(catalog, "god_sword").familyId)
      .toBe("one_handed_sword");
    expect(familyForEquipment(catalog, "heavy_helm").familyId)
      .toBe("head_armor");
    expect(familyForEquipment(catalog, "light_hood").familyId)
      .toBe("head_armor");
  });

  it("creates expandable avatar-style variants in their permanent categories", () => {
    const hair = createStyleAppearanceDraft({
      catalog: structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG),
      appearanceId: "windswept_hair",
      displayName: "Windswept Hair",
      familyId: "hair",
      assetKey: "hair/windswept.png"
    });
    expect(hair.appearance).toMatchObject({
      familyId: "hair",
      cosmetic: true,
      assetKey: "hair/windswept.png",
      salon: {
        state: "selectable",
        accessType: "free",
        gameCreditPrice: 0,
        productId: null
      }
    });
    expect(appearanceCategory(hair.catalog, hair.appearance.appearanceId)).toBe("hair");
    expect(familyForCategory(hair.catalog, "eyes")).toMatchObject({
      familyId: "eyes",
      authoringLayer: "eyes"
    });
    expect(familyForCategory(hair.catalog, "nose_mouth")).toMatchObject({
      familyId: "beard",
      authoringLayer: "face"
    });
  });

  it("authors a standalone Legs overlay without inventing gameplay equipment", () => {
    const draft = createPlayerOverlayAppearanceDraft({
      catalog: structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG),
      appearanceId: "travel_trousers",
      displayName: "Travel Trousers",
      familyId: "legs",
      assetKey: "cosmetics/travel-trousers.png"
    });
    expect(draft.appearance).toEqual({
      appearanceId: "travel_trousers",
      displayName: "Travel Trousers",
      familyId: "legs",
      assetKey: "cosmetics/travel-trousers.png",
      cosmetic: false,
      placements: {}
    });
    expect(resolveAppearancePlacement(draft.catalog, "travel_trousers"))
      .toMatchObject({ anchorId: "legs", layer: "legs" });
    const beard = createPlayerOverlayAppearanceDraft({
      catalog: structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG),
      appearanceId: "short_beard",
      displayName: "Short Beard",
      familyId: "beard",
      assetKey: "cosmetics/short-beard.png"
    });
    expect(beard.appearance).toMatchObject({
      familyId: "beard",
      assetKey: "cosmetics/short-beard.png"
    });
    expect(resolveAppearancePlacement(beard.catalog, "short_beard"))
      .toMatchObject({ anchorId: "face", layer: "face_accessory" });
    expect(() => createPlayerOverlayAppearanceDraft({
      catalog: structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG),
      appearanceId: "not_standalone",
      displayName: "Not Standalone",
      familyId: "chest_tunic",
      assetKey: "cosmetics/not-standalone.png"
    })).toThrow(/authored under Gear/u);
  });

  it.each([
    {
      category: "gloves",
      familyId: "heavy_gloves",
      definitionId: "training_heavy_gloves",
      assetKey: "armor/gloves/ember.png",
      revisedAssetKey: "armor/gloves/ember-revised.png",
      rightAnchor: "right_hand",
      leftAnchor: "left_hand"
    },
    {
      category: "boots",
      familyId: "heavy_boots",
      definitionId: "training_heavy_boots",
      assetKey: "armor/boots/ember.png",
      revisedAssetKey: "armor/boots/ember-revised.png",
      rightAnchor: "right_foot",
      leftAnchor: "left_foot"
    }
  ] as const)("creates and updates mirrored $category parts from one right-side PNG", ({
    category,
    familyId,
    definitionId,
    assetKey,
    revisedAssetKey,
    rightAnchor,
    leftAnchor
  }) => {
    const draft = createItemVariantDraft({
      catalog: structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG),
      itemVariants: structuredClone(ITEM_VARIANT_CATALOG),
      definitionId: `ember_${category}`,
      displayName: `Ember ${category}`,
      familyId,
      assetKey,
      authoringLayer: category,
      partId: "right"
    });
    expect(draft.appearance.parts).toEqual([
      expect.objectContaining({
        partId: "right",
        assetKey,
        placements: { idle: { anchorId: rightAnchor } }
      }),
      expect.objectContaining({
        partId: "left",
        assetKey,
        placements: { idle: { anchorId: leftAnchor, scaleX: -1 } }
      })
    ]);
    expect(resolveAppearancePlacement(
      draft.catalog,
      draft.appearance.appearanceId,
      "idle",
      "left"
    )).toMatchObject({ anchorId: leftAnchor, scaleX: -1 });

    const existingCatalog = structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
    existingCatalog.appearances.push({
      appearanceId: definitionId,
      displayName: `Existing ${category}`,
      familyId: category,
      cosmetic: false,
      equipmentDefinitionId: definitionId,
      placements: {},
      parts: [
        { partId: "right", assetKey, placements: { idle: { anchorId: rightAnchor, offsetX: 11 } } },
        { partId: "left", assetKey, placements: { idle: { anchorId: leftAnchor, scaleX: -1, offsetX: 22 } } }
      ]
    });
    const updated = updateExistingItemAppearance({
      catalog: existingCatalog,
      itemVariants: ITEM_VARIANT_CATALOG,
      definitionId,
      assetKey: revisedAssetKey,
      partId: "right"
    });
    expect(updated.appearance.parts).toEqual([
      expect.objectContaining({
        partId: "right",
        assetKey: revisedAssetKey,
        placements: { idle: { anchorId: rightAnchor, offsetX: 11 } }
      }),
      expect.objectContaining({
        partId: "left",
        assetKey: revisedAssetKey,
        placements: { idle: { anchorId: leftAnchor, scaleX: -1, offsetX: 22 } }
      })
    ]);

    const incomplete = existingCatalog.appearances.find((appearance) =>
      appearance.appearanceId === definitionId
    )!;
    incomplete.parts = incomplete.parts!.filter((part) => part.partId === "right");
    const completed = updateExistingItemAppearance({
      catalog: existingCatalog,
      itemVariants: ITEM_VARIANT_CATALOG,
      definitionId,
      assetKey: revisedAssetKey,
      partId: "right"
    });
    expect(completed.appearance.parts?.find((part) => part.partId === "left"))
      .toMatchObject({
        assetKey: revisedAssetKey,
        placements: { idle: { anchorId: leftAnchor, scaleX: -1 } }
      });
  });

  it("preserves single-part imports for non-paired authoring layers", () => {
    const draft = createItemVariantDraft({
      catalog: structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG),
      itemVariants: structuredClone(ITEM_VARIANT_CATALOG),
      definitionId: "single_part_sword",
      displayName: "Single Part Sword",
      familyId: "sword",
      assetKey: "weapons/single-part.png",
      authoringLayer: "primary_weapon",
      partId: "left"
    });
    expect(draft.appearance.parts).toEqual([{
      partId: "left",
      assetKey: "weapons/single-part.png",
      placements: { idle: { anchorId: "left_hand" } }
    }]);
  });
});
