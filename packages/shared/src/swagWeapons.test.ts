import { describe, expect, it } from "vitest";

import { baseAppearanceForEquipment, resolveAppearancePlacement } from "./appearance.js";
import { DEFAULT_PLAYER_APPEARANCE_CATALOG } from "./appearanceCatalog.js";
import {
  EQUIPMENT_CRAFT_RECIPES,
  EQUIPMENT_SWAG_CRAFT_RECIPES,
  equipmentSwagCraftRecipe,
  requireEquipmentDefinition,
  type EquipmentDefinition,
  type EquipmentDefinitionId
} from "./equipment.js";
import { MOB_DROP_ITEM_IDS } from "./mobDropItems.js";

const BASE_APPEARANCE: Readonly<Record<string, string>> = {
  starter_sword: "sword",
  double_axe: "double_axe",
  starter_bow: "starter-bow",
  training_crossbow: "starter-bow",
  training_spear: "starter-staff",
  starter_staff: "starter-staff",
  starter_shuriken: "starter-shuriken",
  training_sling: "starter-shuriken"
};

function mechanics(definition: EquipmentDefinition) {
  const {
    definitionId: _definitionId,
    displayName: _displayName,
    equipmentRole: _equipmentRole,
    marketTradable: _marketTradable,
    baseDefinitionId: _baseDefinitionId,
    appearanceId: _appearanceId,
    ...rest
  } = definition;
  return rest;
}

describe("swag weapons", () => {
  it("publishes 24 cosmetic recipes, three per base weapon, as base recipe plus mob drops", () => {
    expect(EQUIPMENT_SWAG_CRAFT_RECIPES).toHaveLength(24);
    const perBase = new Map<string, number>();
    for (const recipe of EQUIPMENT_SWAG_CRAFT_RECIPES) {
      perBase.set(recipe.baseDefinitionId, (perBase.get(recipe.baseDefinitionId) ?? 0) + 1);
      const base = EQUIPMENT_CRAFT_RECIPES.find((candidate) => candidate.familyId === recipe.familyId)!;
      expect(recipe.baseDefinitionId).toBe(base.definitionId);
      expect(recipe.materials.slice(0, base.materials.length)).toEqual(base.materials);
      const extras = recipe.materials.slice(base.materials.length);
      expect(extras.length).toBeGreaterThan(0);
      for (const extra of extras) {
        expect(MOB_DROP_ITEM_IDS as readonly string[]).toContain(extra.itemId);
      }
      expect(equipmentSwagCraftRecipe(recipe.definitionId)).toBe(recipe);
    }
    expect(Object.fromEntries(perBase)).toEqual(Object.fromEntries(
      Object.keys(BASE_APPEARANCE).map((id) => [id, 3])
    ));
    expect(equipmentSwagCraftRecipe("legion_gladius")?.materials).toEqual([
      { itemId: "iron_bar", quantity: 10 },
      { itemId: "wood", quantity: 50 },
      { itemId: "rusted_legion_blade", quantity: 3 },
      { itemId: "ancient_coin", quantity: 3 }
    ]);
    // Other cosmetics never gain a recipe.
    expect(equipmentSwagCraftRecipe("double_axe")).toBeNull();
    expect(equipmentSwagCraftRecipe("non-swag-cloth")).toBeNull();
    expect(equipmentSwagCraftRecipe("starter_sword")).toBeNull();
  });

  it("keeps the base family's mechanics, is cosmetic and market tradable", () => {
    for (const recipe of EQUIPMENT_SWAG_CRAFT_RECIPES) {
      const swag = requireEquipmentDefinition(recipe.definitionId);
      const base = requireEquipmentDefinition(recipe.baseDefinitionId);
      expect(swag).toMatchObject({
        equipmentRole: "cosmetic",
        marketTradable: true,
        gameplayFamilyId: base.gameplayFamilyId,
        appearanceId: recipe.definitionId
      });
      expect(mechanics(swag)).toEqual(mechanics(base));
    }
  });

  it("resolves each swag item to its own appearance placed like its base weapon", () => {
    const catalog = DEFAULT_PLAYER_APPEARANCE_CATALOG;
    for (const recipe of EQUIPMENT_SWAG_CRAFT_RECIPES) {
      const appearance = baseAppearanceForEquipment(catalog, recipe.definitionId);
      expect(appearance).toMatchObject({
        appearanceId: recipe.definitionId,
        assetKey: `weapons/swag/${recipe.definitionId.replaceAll("_", "-")}.png`
      });
      const baseAppearanceId = BASE_APPEARANCE[recipe.baseDefinitionId]!;
      for (const pose of ["idle", "combat_ready", "attack_action"] as const) {
        expect(resolveAppearancePlacement(catalog, recipe.definitionId, pose))
          .toEqual(resolveAppearancePlacement(catalog, baseAppearanceId, pose));
      }
      const base = catalog.appearances.find((candidate) => candidate.appearanceId === baseAppearanceId)!;
      expect(appearance?.projectileAssetKey).toBe(base.projectileAssetKey);
    }
    // Stock weapons keep the appearance they had before the swag entries were appended.
    for (const [definitionId, appearanceId] of Object.entries(BASE_APPEARANCE)) {
      expect(baseAppearanceForEquipment(catalog, definitionId as EquipmentDefinitionId)?.appearanceId)
        .toBe(appearanceId);
    }
  });
});
