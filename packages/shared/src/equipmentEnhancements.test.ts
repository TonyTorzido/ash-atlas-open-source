import { describe, expect, it } from "vitest";

import {
  EQUIPMENT_METAL_IDS,
  equipmentMetalDefinition,
  equipmentUpgradeCostForIdentity,
  metalInfusionKind,
  metalProcQualityMultiplier,
  equipmentAppearanceEnhancement,
  equipmentEffectDisplayName,
  equipmentMetalDisplayName,
  equipmentRequiredAchievementId,
  elementalEquipmentEnhancement,
  isVenomsteelPoisonEnhancement,
  parseEquipmentEnhancement,
  poisonEquipmentEnhancement,
  preparedEquipmentEnhancement,
  serializeEquipmentEnhancement,
  supportsJewelStationEnhancement,
  venomsteelImbuementKind
} from "./equipmentEnhancements.js";
import { requireEquipmentDefinition } from "./equipment.js";

describe("equipment enhancement identity", () => {
  it("maps stable infusion identities to standardized player-facing names", () => {
    expect(equipmentMetalDisplayName("venomsteel")).toBe("Venom");
    expect(equipmentMetalDisplayName("fire")).toBe("Ember");
    expect(equipmentMetalDisplayName("lightning")).toBe("Storm");
    expect(equipmentMetalDisplayName("ice")).toBe("Frost");
    expect(equipmentEffectDisplayName("poison")).toBe("Poisoned");
    expect(equipmentEffectDisplayName("burning")).toBe("Burning");
    expect(equipmentEffectDisplayName("storm")).toBe("Electrified");
    expect(equipmentEffectDisplayName("slow")).toBe("Slowed");
  });

  it("round-trips prepared and Venomsteel identities without inventing gemstone effects", () => {
    const prepared = preparedEquipmentEnhancement("opal");
    expect(serializeEquipmentEnhancement(prepared)).toBe("enh:v1:opal:prepared");
    expect(parseEquipmentEnhancement("enh:v1:opal:prepared")).toEqual(prepared);

    expect(parseEquipmentEnhancement("enh:v1:onyx:prepared")).toEqual(
      preparedEquipmentEnhancement("onyx")
    );
    expect(parseEquipmentEnhancement("enh:v1:topaz:venomsteel")).toEqual(
      poisonEquipmentEnhancement("topaz")
    );

    const imbued = poisonEquipmentEnhancement("diamond");
    expect(serializeEquipmentEnhancement(imbued)).toBe("enh:v1:diamond:venomsteel");
    expect(parseEquipmentEnhancement("enh:v1:diamond:venomsteel")).toEqual(imbued);
    expect(equipmentRequiredAchievementId("enh:v1:diamond:venomsteel")).toBe("bitter_blood");
  });

  it("rejects unknown and malformed persisted identities", () => {
    expect(parseEquipmentEnhancement("enh:v2:opal:venomsteel")).toBeNull();
    expect(parseEquipmentEnhancement("enh:v1:quartz:prepared")).toBeNull();
    expect(equipmentRequiredAchievementId("legacy-value")).toBeNull();
  });

  it("round-trips elemental identities without inheriting Bitter Blood", () => {
    for (const gemstone of ["ruby", "onyx", "topaz"] as const) {
      for (const metal of ["fire", "lightning", "ice"] as const) {
        const enhancement = elementalEquipmentEnhancement(gemstone, metal);
        const identity = `enh:v1:${gemstone}:${metal}`;
        expect(serializeEquipmentEnhancement(enhancement)).toBe(identity);
        expect(parseEquipmentEnhancement(identity)).toEqual(enhancement);
        expect(equipmentRequiredAchievementId(identity)).toBeNull();
      }
    }
  });

  it("allows ordinary starter and cosmetic equipment but rejects protected definitions", () => {
    expect(supportsJewelStationEnhancement(requireEquipmentDefinition("starter_sword"))).toBe(true);
    expect(supportsJewelStationEnhancement(requireEquipmentDefinition("double_axe"))).toBe(true);
    expect(supportsJewelStationEnhancement(requireEquipmentDefinition("god_sword"))).toBe(false);
    expect(supportsJewelStationEnhancement(requireEquipmentDefinition("training_heavy_chest"))).toBe(false);
    expect(supportsJewelStationEnhancement(requireEquipmentDefinition("hammer"))).toBe(true);
    expect(supportsJewelStationEnhancement(requireEquipmentDefinition("training_ring"))).toBe(false);
  });

  it("projects durable identities into renderer-only gem and core presentation", () => {
    expect(equipmentAppearanceEnhancement("enh:v1:ruby:prepared")).toEqual({
      gemstone: "ruby",
      coreId: null
    });
    expect(equipmentAppearanceEnhancement("enh:v1:diamond:venomsteel")).toEqual({
      gemstone: "diamond",
      coreId: "venomsteel"
    });
    expect(equipmentAppearanceEnhancement("invalid")).toBeNull();
  });

  it("limits new Venomsteel preparation to weapons and armor", () => {
    expect(venomsteelImbuementKind("melee_weapon")).toBe("weapon");
    expect(venomsteelImbuementKind("ranged_weapon")).toBe("weapon");
    expect(venomsteelImbuementKind("head_armor")).toBe("armor");
    expect(venomsteelImbuementKind("chest_armor")).toBe("armor");
    expect(venomsteelImbuementKind("gloves")).toBe("armor");
    expect(venomsteelImbuementKind("boots")).toBe("armor");
    expect(venomsteelImbuementKind("shield")).toBeNull();
    expect(venomsteelImbuementKind("ring")).toBeNull();
    expect(isVenomsteelPoisonEnhancement("enh:v1:emerald:venomsteel")).toBe(true);
    expect(isVenomsteelPoisonEnhancement("enh:v1:emerald:prepared")).toBe(false);
  });
});

describe("metal framework", () => {
  it("parses every metal, with and without a gemstone", () => {
    for (const id of EQUIPMENT_METAL_IDS) {
      const gemless = parseEquipmentEnhancement(`enh:v1:none:${id}`);
      expect(gemless).toMatchObject({ gemstone: null, metal: id });
      expect(serializeEquipmentEnhancement(gemless!)).toBe(`enh:v1:none:${id}`);
      expect(parseEquipmentEnhancement(`enh:v1:ruby:${id}`)).toMatchObject({ gemstone: "ruby", metal: id });
      expect(equipmentMetalDefinition(id).barItemId).toBe(`${id}_bar`);
    }
    expect(parseEquipmentEnhancement("enh:v1:none:prepared")).toBeNull();
    expect(parseEquipmentEnhancement("enh:v1:none:unobtainium")).toBeNull();
    expect(equipmentAppearanceEnhancement("enh:v1:none:revenant")).toBeNull();
  });

  it("limits new infusions to weapons, chest armor and shields", () => {
    expect(metalInfusionKind("melee_weapon")).toBe("weapon");
    expect(metalInfusionKind("chest_armor")).toBe("armor");
    expect(metalInfusionKind("shield")).toBe("armor");
    expect(metalInfusionKind("head_armor")).toBeNull();
    expect(metalInfusionKind("boots")).toBeNull();
  });

  it("clamps the proc quality multiplier and raises infused upgrade cost by 30%", () => {
    expect(metalProcQualityMultiplier(10, 10)).toBe(1);
    expect(metalProcQualityMultiplier(14, 10)).toBeCloseTo(1.3333, 3);
    expect(metalProcQualityMultiplier(40, 0)).toBe(1.5);
    expect(metalProcQualityMultiplier(0, 40)).toBe(0.5);
    expect(equipmentUpgradeCostForIdentity(100, "enh:v1:none:gale")).toBe(130);
    expect(equipmentUpgradeCostForIdentity(10, "enh:v1:ruby:fire")).toBe(13);
    expect(equipmentUpgradeCostForIdentity(100, "enh:v1:ruby:prepared")).toBe(100);
    expect(equipmentUpgradeCostForIdentity(100, null)).toBe(100);
  });
});
