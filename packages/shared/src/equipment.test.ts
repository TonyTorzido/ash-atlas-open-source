import { describe, expect, it } from "vitest";

import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CRAFT_RECIPES,
  EQUIPMENT_DEFINITIONS,
  EQUIPMENT_GAMEPLAY_FAMILIES,
  EQUIPMENT_SLOTS,
  MAX_EQUIPMENT_LEVEL,
  MIN_EQUIPMENT_LEVEL,
  activeEquipmentLimitedSales,
  equipmentSlotForCategory,
  equipmentDefinitionFromItemVariant,
  isStockEquipmentDefinition,
  isEquipmentCategoryAllowedInSlot,
  parseItemVariantCatalog,
  requireEquipmentDefinition,
  requireEquipmentLevel,
  stockEquipmentDefinitionForFamily
} from "./equipment.js";
import { resolveV3WeaponProfileForEquipmentFamily } from "./damageMatrixV3.js";
import { venomsteelImbuementKind } from "./equipmentEnhancements.js";

describe("equipment definitions", () => {
  it("owns the exact nine slots and nine category-to-slot rules", () => {
    expect(EQUIPMENT_SLOTS).toEqual([
      "head", "chest", "gloves", "boots", "ring", "ring_2", "melee", "secondary", "tool_axe", "tool_pickaxe", "tool_fishing_pole"
    ]);
    expect(EQUIPMENT_CATEGORIES).toEqual([
      "melee_weapon", "ranged_weapon", "shield", "head_armor",
      "chest_armor", "gloves", "boots", "ring",
      "gathering_axe", "gathering_pickaxe", "gathering_fishing_pole"
    ]);
    expect(EQUIPMENT_CATEGORIES.map((category) => [
      category,
      equipmentSlotForCategory(category)
    ])).toEqual([
      ["melee_weapon", "melee"],
      ["ranged_weapon", "secondary"],
      ["shield", "secondary"],
      ["head_armor", "head"],
      ["chest_armor", "chest"],
      ["gloves", "gloves"],
      ["boots", "boots"],
      ["ring", "ring"],
      ["gathering_axe", "tool_axe"],
      ["gathering_pickaxe", "tool_pickaxe"],
      ["gathering_fishing_pole", "tool_fishing_pole"]
    ]);
    expect(isEquipmentCategoryAllowedInSlot("gathering_axe", "melee")).toBe(false);
    expect(isEquipmentCategoryAllowedInSlot("gathering_axe", "tool_pickaxe")).toBe(false);
    expect(isEquipmentCategoryAllowedInSlot("gathering_pickaxe", "tool_axe")).toBe(false);
    expect(isEquipmentCategoryAllowedInSlot("gathering_fishing_pole", "tool_axe")).toBe(false);
    expect(isEquipmentCategoryAllowedInSlot("melee_weapon", "tool_axe")).toBe(false);
    expect(isEquipmentCategoryAllowedInSlot("shield", "secondary")).toBe(true);
    expect(isEquipmentCategoryAllowedInSlot("shield", "melee")).toBe(false);
    expect(isEquipmentCategoryAllowedInSlot("ring", "ring_2")).toBe(true);
    expect(isEquipmentCategoryAllowedInSlot("boots", "ring_2")).toBe(false);
  });

  it("maps retained starter definitions into the new category-owned slots", () => {
    expect(EQUIPMENT_DEFINITIONS.starter_sword).toMatchObject({
      displayName: "Sword",
      slot: "melee",
      category: "melee_weapon",
      statScope: "universal",
      attackPowerBonus: 0,
      defenseBonus: 0
    });
    expect(EQUIPMENT_DEFINITIONS.padded_tunic).toMatchObject({
      displayName: "Tunic",
      slot: "chest",
      category: "chest_armor",
      statScope: "universal",
      attackPowerBonus: 0,
      defenseBonus: 0
    });
    expect(EQUIPMENT_DEFINITIONS.starter_staff).toMatchObject({
      displayName: "Staff",
      slot: "melee",
      category: "melee_weapon",
      statScope: "universal",
      attackPowerBonus: 0,
      defenseBonus: 0,
      weaponCategory: "staff",
      damageWeaponType: "staff",
      twoHanded: true
    });
    expect(EQUIPMENT_DEFINITIONS.starter_shuriken).toMatchObject({
      slot: "secondary", category: "ranged_weapon", damageWeaponType: "shuriken"
    });
    expect(EQUIPMENT_DEFINITIONS.starter_wand).toMatchObject({
      slot: "secondary", category: "ranged_weapon", damageWeaponType: "wand"
    });
  });

  it("defines a complete non-granted training kit with explicit V2 scopes", () => {
    expect(EQUIPMENT_DEFINITIONS.training_axe).toMatchObject({
      slot: "melee",
      category: "melee_weapon",
      weaponCategory: "axe",
      statScope: "universal",
      basePveAttackContribution: 0
    });
    expect([
      EQUIPMENT_DEFINITIONS.training_heavy_helm,
      EQUIPMENT_DEFINITIONS.training_heavy_gloves,
      EQUIPMENT_DEFINITIONS.training_heavy_boots
    ].map((definition) => [definition.slot, definition.armorCategory])).toEqual([
      ["head", "heavy"],
      ["gloves", "heavy"],
      ["boots", "heavy"]
    ]);
    expect(EQUIPMENT_DEFINITIONS.training_ring).toMatchObject({
      slot: "ring",
      category: "ring",
      armorCategory: null
    });
    expect(EQUIPMENT_DEFINITIONS.training_shield).toMatchObject({
      slot: "secondary",
      category: "shield",
      weaponCategory: "shield",
      statScope: "universal",
      basePveDefenseContribution: 0,
      damageShieldType: "melee"
    });
    expect(EQUIPMENT_DEFINITIONS.ranged_shield.damageShieldType).toBe("ranged");
    expect(EQUIPMENT_DEFINITIONS.chain_armor).toMatchObject({
      displayName: "Chainmail Armor",
      gameplayFamilyId: "chain_mail",
      damageArmorType: "chainmail"
    });
    expect([
      EQUIPMENT_DEFINITIONS.training_light_hood,
      EQUIPMENT_DEFINITIONS.padded_tunic,
      EQUIPMENT_DEFINITIONS.training_light_gloves,
      EQUIPMENT_DEFINITIONS.training_light_boots
    ].map((definition) => definition.armorCategory)).toEqual([
      "light", "light", "light", "light"
    ]);
  });

  it("rejects unknown client-selected definitions", () => {
    expect(() => requireEquipmentDefinition("legendary_cheat_sword")).toThrow(/unknown/i);
  });

  it("validates item variants as distinct definitions linked to family-owned gameplay", () => {
    const catalog = parseItemVariantCatalog({
      schemaVersion: 2,
      variants: [{
        definitionId: "ember_sword",
        displayName: "Ember Sword",
        familyId: "sword",
        role: "cosmetic",
        appearanceId: "ember_sword"
      }]
    });
    expect(catalog.variants[0]).toEqual({
      definitionId: "ember_sword",
      displayName: "Ember Sword",
      familyId: "sword",
      role: "cosmetic",
      appearanceId: "ember_sword"
    });
    expect(equipmentDefinitionFromItemVariant(catalog.variants[0]!)).toMatchObject({
      definitionId: "ember_sword",
      displayName: "Ember Sword",
      baseDefinitionId: "starter_sword",
      appearanceId: "ember_sword",
      equipmentRole: "cosmetic",
      gameplayFamilyId: "sword",
      weaponCategory: EQUIPMENT_DEFINITIONS.starter_sword.weaponCategory,
      damageWeaponType: EQUIPMENT_DEFINITIONS.starter_sword.damageWeaponType,
      basePveAttackContribution: EQUIPMENT_DEFINITIONS.starter_sword.basePveAttackContribution
    });
    expect(() => parseItemVariantCatalog({
      schemaVersion: 2,
      variants: [{
        definitionId: "starter_sword",
        displayName: "Replacement",
        familyId: "sword",
        role: "cosmetic",
        appearanceId: "replacement"
      }]
    })).toThrow(/cannot replace base equipment/u);
    expect(() => parseItemVariantCatalog({
      schemaVersion: 2,
      variants: [{
        definitionId: "cheat_sword",
        displayName: "Cheat Sword",
        familyId: "sword",
        role: "cosmetic",
        appearanceId: "cheat_sword",
        damageWeaponType: "wand"
      }]
    })).toThrow();
  });

  it("publishes Double Axe and Breastplate with stable gameplay identities", () => {
    const doubleAxe = requireEquipmentDefinition("double_axe");
    const breastPlate = requireEquipmentDefinition("breast_plate");

    expect(doubleAxe).toMatchObject({
      definitionId: "double_axe",
      displayName: "Double Axe",
      baseDefinitionId: "double_axe",
      appearanceId: "double_axe",
      slot: "melee",
      category: "melee_weapon",
      weaponCategory: "axe",
      gameplayFamilyId: "axe",
      equipmentRole: "stock",
      marketTradable: true
    });
    expect(breastPlate).toMatchObject({
      definitionId: "breast_plate",
      displayName: "Breastplate",
      baseDefinitionId: "breast_plate",
      appearanceId: "breast_plate",
      slot: "chest",
      category: "chest_armor",
      armorCategory: "heavy",
      damageArmorType: "breastplate",
      gameplayFamilyId: "breastplate",
      equipmentRole: "stock",
      marketTradable: true
    });
    expect(isEquipmentCategoryAllowedInSlot(
      doubleAxe.category,
      "melee"
    )).toBe(true);
    expect(isEquipmentCategoryAllowedInSlot(
      breastPlate.category,
      "chest"
    )).toBe(true);
  });

  it("gives cosmetic items exactly the mechanics owned by their family", () => {
    const mechanicalFields = (definition: typeof EQUIPMENT_DEFINITIONS.starter_sword) => ({
      slot: definition.slot,
      category: definition.category,
      statScope: definition.statScope,
      utilityKind: definition.utilityKind,
      basePveAttackContribution: definition.basePveAttackContribution,
      basePveDefenseContribution: definition.basePveDefenseContribution,
      weaponCategory: definition.weaponCategory,
      armorCategory: definition.armorCategory,
      damageWeaponType: definition.damageWeaponType,
      damageArmorType: definition.damageArmorType,
      damageShieldType: definition.damageShieldType,
      twoHanded: definition.twoHanded,
      gameplayFamilyId: definition.gameplayFamilyId
    });
    expect(mechanicalFields(requireEquipmentDefinition("double_axe")))
      .toEqual(mechanicalFields(EQUIPMENT_DEFINITIONS.training_axe));
    expect(mechanicalFields(requireEquipmentDefinition("hammer"))).toEqual({
      ...mechanicalFields(requireEquipmentDefinition("double_axe")),
      weaponCategory: "hammer",
      gameplayFamilyId: "hammer"
    });
    expect(EQUIPMENT_GAMEPLAY_FAMILIES.hammer.stockDefinitionId).toBe("hammer");
    expect(isStockEquipmentDefinition("hammer")).toBe(true);
    expect(EQUIPMENT_GAMEPLAY_FAMILIES.sword.stockDefinitionId).toBe("starter_sword");
    expect(EQUIPMENT_GAMEPLAY_FAMILIES.leather.stockDefinitionId).toBe("leather_armor");
    expect(EQUIPMENT_GAMEPLAY_FAMILIES.breastplate.stockDefinitionId).toBe("breast_plate");
    expect(EQUIPMENT_GAMEPLAY_FAMILIES.breastplate.authoringBaseDefinitionId)
      .toBe("breast_plate");
    expect(EQUIPMENT_DEFINITIONS.training_heavy_chest).toMatchObject({
      retired: true,
      marketTradable: false,
      equipmentRole: "special"
    });
    expect(stockEquipmentDefinitionForFamily("sword").displayName).toBe("Sword");
    expect(isStockEquipmentDefinition("starter_sword")).toBe(true);
    expect(isStockEquipmentDefinition("double_axe")).toBe(true);
    expect(EQUIPMENT_GAMEPLAY_FAMILIES.axe.stockDefinitionId).toBe("double_axe");
    expect(EQUIPMENT_DEFINITIONS.training_axe).toMatchObject({
      retired: true,
      marketTradable: false,
      equipmentRole: "special"
    });
    expect(isStockEquipmentDefinition("training_axe")).toBe(false);
  });

  it("publishes the twenty-two stock recipes with no active limited sales", () => {
    // Blowdart also takes 5 any Bones (category input, lowest grade first).
    expect(EQUIPMENT_CRAFT_RECIPES.find((recipe) => recipe.familyId === "blowdart")?.categoryMaterials)
      .toEqual([{ category: { groups: ["bones"], label: "any Bones" }, quantity: 5 }]);
    expect(EQUIPMENT_CRAFT_RECIPES.map((recipe) => [
      recipe.familyId,
      recipe.definitionId,
      recipe.materials
    ])).toEqual([
      ["sword", "starter_sword", [
        { itemId: "iron_bar", quantity: 10 }, { itemId: "wood", quantity: 50 }
      ]],
      ["axe", "double_axe", [
        { itemId: "iron_bar", quantity: 12 }, { itemId: "wood", quantity: 50 }
      ]],
      ["hammer", "hammer", [
        { itemId: "iron_bar", quantity: 14 }, { itemId: "wood", quantity: 40 }
      ]],
      ["bow", "starter_bow", [{ itemId: "wood", quantity: 250 }]],
      ["staff", "starter_staff", [{ itemId: "wood", quantity: 250 }]],
      ["shuriken", "starter_shuriken", [{ itemId: "iron_bar", quantity: 10 }]],
      ["wand", "starter_wand", [
        { itemId: "iron_bar", quantity: 3 }, { itemId: "wood", quantity: 200 }
      ]],
      ["spear", "training_spear", [
        { itemId: "iron_bar", quantity: 10 }, { itemId: "wood", quantity: 100 }
      ]],
      ["dagger", "training_dagger", [
        { itemId: "iron_bar", quantity: 6 }, { itemId: "leather", quantity: 20 }
      ]],
      ["brass_knuckles", "training_knuckles", [
        { itemId: "iron_bar", quantity: 8 }, { itemId: "leather", quantity: 10 }
      ]],
      ["crossbow", "training_crossbow", [
        { itemId: "iron_bar", quantity: 6 }, { itemId: "wood", quantity: 150 }, { itemId: "cloth", quantity: 10 }
      ]],
      ["blowdart", "training_blowdart", [
        { itemId: "wood", quantity: 150 }, { itemId: "flax_fiber", quantity: 20 }
      ]],
      ["sling", "training_sling", [
        { itemId: "leather", quantity: 60 }, { itemId: "cloth", quantity: 20 }
      ]],
      ["scepter", "training_scepter", [
        { itemId: "iron_bar", quantity: 8 }, { itemId: "wood", quantity: 60 }, { itemId: "cloth", quantity: 10 }
      ]],
      ["tunic", "padded_tunic", [{ itemId: "cloth", quantity: 60 }]],
      ["leather", "leather_armor", [{ itemId: "leather", quantity: 150 }]],
      ["chain_mail", "chain_armor", [{ itemId: "dragon_scale", quantity: 10 }, { itemId: "iron_bar", quantity: 8 }]],
      ["breastplate", "breast_plate", [
        { itemId: "iron_bar", quantity: 15 }, { itemId: "leather", quantity: 50 }
      ]],
      ["ranged_shield", "ranged_shield", [
        { itemId: "dragon_scale", quantity: 6 }, { itemId: "iron_bar", quantity: 8 }, { itemId: "wood", quantity: 50 }
      ]],
      ["wooden_axe", "wooden_axe", [{ itemId: "wood", quantity: 20 }]],
      ["stone_axe", "stone_axe", [
        { itemId: "wood", quantity: 15 }, { itemId: "stone", quantity: 20 }
      ]],
      ["wooden_pickaxe", "wooden_pickaxe", [{ itemId: "wood", quantity: 20 }]],
      ["stone_pickaxe", "stone_pickaxe", [
        { itemId: "wood", quantity: 15 }, { itemId: "stone", quantity: 20 }
      ]],
      ["starter_fishing_pole", "starter_fishing_pole", [
        { itemId: "wood", quantity: 15 }, { itemId: "flax_fiber", quantity: 10 }
      ]]
    ]);
    expect(EQUIPMENT_CRAFT_RECIPES.every((recipe) =>
      requireEquipmentDefinition(recipe.definitionId).equipmentRole === "stock"
    )).toBe(true);

    expect(activeEquipmentLimitedSales(new Date("2026-08-17T12:00:00Z"))).toEqual([]);
  });

  it("defines the six weapon families with slot, hands, matrix profile and metal-infusable category", () => {
    const expected = [
      ["spear", "training_spear", "melee", "melee_weapon", false, "spear"],
      ["dagger", "training_dagger", "melee", "melee_weapon", false, "dagger"],
      ["brass_knuckles", "training_knuckles", "melee", "melee_weapon", false, "brass_knuckles"],
      ["crossbow", "training_crossbow", "secondary", "ranged_weapon", true, "crossbow"],
      ["blowdart", "training_blowdart", "secondary", "ranged_weapon", true, "blowdart"],
      ["sling", "training_sling", "secondary", "ranged_weapon", true, "sling"]
    ] as const;
    for (const [familyId, stockId, slot, category, twoHanded, profile] of expected) {
      const definition = requireEquipmentDefinition(stockId);
      expect(definition, familyId).toMatchObject({
        gameplayFamilyId: familyId, slot, category, twoHanded, weaponCategory: familyId, equipmentRole: "stock"
      });
      expect(resolveV3WeaponProfileForEquipmentFamily(familyId)).toMatchObject({
        pvpDamageProfileMode: "matrix_v3", profile
      });
      expect(resolveV3WeaponProfileForEquipmentFamily(stockId).profile).toBe(profile);
      expect(venomsteelImbuementKind(definition.category)).toBe("weapon");
    }
  });

  it("defines the Scepter as a one-handed melee family with the staff matrix row as a placeholder", () => {
    const definition = requireEquipmentDefinition("training_scepter");
    expect(definition).toMatchObject({
      gameplayFamilyId: "scepter", slot: "melee", category: "melee_weapon", twoHanded: false,
      weaponCategory: "scepter", equipmentRole: "stock", marketTradable: true
    });
    expect(resolveV3WeaponProfileForEquipmentFamily("scepter").profile).toBe("staff");
    expect(resolveV3WeaponProfileForEquipmentFamily("training_scepter").profile).toBe("staff");
  });

  it("rejects limited-sale mechanics on stock items and invalid windows", () => {
    const sale = {
      priceGold: "5000",
      startsAt: "2026-08-17T00:00:00Z",
      endsAt: "2026-12-31T23:59:59Z"
    };
    expect(() => parseItemVariantCatalog({
      schemaVersion: 2,
      variants: [{
        definitionId: "sale_stock_sword",
        displayName: "Sale Stock Sword",
        familyId: "sword",
        role: "stock",
        appearanceId: "sale_stock_sword",
        limitedSale: sale
      }]
    })).toThrow(/cosmetic/u);
    expect(() => parseItemVariantCatalog({
      schemaVersion: 2,
      variants: [{
        definitionId: "bad_window_sword",
        displayName: "Bad Window Sword",
        familyId: "sword",
        role: "cosmetic",
        appearanceId: "bad_window_sword",
        limitedSale: { ...sale, endsAt: sale.startsAt }
      }]
    })).toThrow(/end must be after/u);
  });

  it("maps every combat weapon, chest, and shield definition explicitly", () => {
    for (const definition of Object.values(EQUIPMENT_DEFINITIONS)) {
      if (definition.category === "melee_weapon" || definition.category === "ranged_weapon") {
        expect(definition.damageWeaponType, definition.definitionId).toBeTruthy();
      }
      if (definition.category === "chest_armor") {
        expect(definition.damageArmorType, definition.definitionId).toBeTruthy();
      }
      if (definition.category === "shield") {
        expect(definition.damageShieldType, definition.definitionId).toBeTruthy();
      }
    }
  });

  it("retires the stock rings and makes every random ring tier tradable", () => {
    for (const definitionId of ["training_ring", "chopping_ring", "mining_ring", "attack_ring"] as const) {
      expect(requireEquipmentDefinition(definitionId).retired).toBe(true);
    }
    for (const definitionId of ["ring_plain", "ring_fine", "ring_prime", "ring_peerless"] as const) {
      expect(requireEquipmentDefinition(definitionId)).toMatchObject({ marketTradable: true, slot: "ring" });
    }
  });

  it("treats every integer level from zero through the level cap as authoritative", () => {
    expect(MIN_EQUIPMENT_LEVEL).toBe(0);
    expect(MAX_EQUIPMENT_LEVEL).toBe(25);
    for (let level = 0; level <= 25; level += 1) {
      expect(requireEquipmentLevel(level)).toBe(level);
    }
    for (const invalid of [-1, 26, 40, 0.5, Number.NaN]) {
      expect(() => requireEquipmentLevel(invalid)).toThrow(/between 0 and 25/i);
    }
  });
});
