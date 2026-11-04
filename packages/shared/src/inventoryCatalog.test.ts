import { describe, expect, it } from "vitest";

import { EQUIPMENT_DEFINITION_IDS } from "./equipment.js";
import { INVENTORY_CATALOG, ITEM_RARITIES } from "./inventoryCatalog.js";

describe("item rarity catalog", () => {
  it("assigns one of the five item rarities to every definition", () => {
    expect(ITEM_RARITIES).toEqual([
      "common",
      "uncommon",
      "rare",
      "epic",
      "legendary"
    ]);
    for (const item of Object.values(INVENTORY_CATALOG)) {
      expect(ITEM_RARITIES).toContain(item.rarity);
    }
  });

  it("assigns the first material rarities without inventing a Resin item", () => {
    expect(Object.fromEntries([
      "wood",
      "stone",
      "leather",
      "balsam_resin",
      "jellyfish_venom",
      "atlas_shrine_shard"
    ].map((itemId) => [itemId, INVENTORY_CATALOG[itemId]?.rarity]))).toEqual({
      wood: "common",
      stone: "common",
      leather: "common",
      balsam_resin: "uncommon",
      jellyfish_venom: "rare",
      atlas_shrine_shard: "rare"
    });
    expect(INVENTORY_CATALOG.resin).toBeUndefined();
    expect(INVENTORY_CATALOG.crude_oil?.rarity).toBe("common");
    for (const definitionId of EQUIPMENT_DEFINITION_IDS) {
      expect(INVENTORY_CATALOG[definitionId]?.rarity).toBe("common");
    }
  });

  it("assigns exact species-material rarities and keeps standard Leather Common", () => {
    expect(Object.fromEntries([
      "deer_hide",
      "hog_hide",
      "wolf_pelt",
      "bear_hide",
      "alligator_hide",
      "leather"
    ].map((itemId) => [itemId, INVENTORY_CATALOG[itemId]?.rarity]))).toEqual({
      deer_hide: "common",
      hog_hide: "common",
      wolf_pelt: "uncommon",
      bear_hide: "uncommon",
      alligator_hide: "uncommon",
      leather: "common"
    });
  });
});

describe("inventory equipment catalog", () => {
  it("allows every equipment definition to enter the ground-drop flow", () => {
    expect(EQUIPMENT_DEFINITION_IDS).not.toHaveLength(0);
    for (const definitionId of EQUIPMENT_DEFINITION_IDS) {
      expect(INVENTORY_CATALOG[definitionId]?.droppable).toBe(true);
    }
  });
});

describe("Enchantment Stone catalog", () => {
  it("allows exact gemstone variants to be dropped and traded", () => {
    expect(INVENTORY_CATALOG.enchantment_stone).toMatchObject({
      droppable: true,
      marketTradable: true,
      marketFungible: true,
      marketIdentity: "enchantment_stone"
    });
  });
});

describe("Fishing Rod market catalog", () => {
  it("keeps rods tradable without treating each durable instance as fungible", () => {
    expect(INVENTORY_CATALOG.fishing_rod).toMatchObject({
      stackable: false,
      maxStack: 1,
      marketTradable: true,
      marketFungible: false,
      marketIdentity: "fishing_rod"
    });
  });
});

describe("infusion family catalog names", () => {
  it("keeps stable item IDs while exposing standardized bar, core, and feather names", () => {
    expect(Object.fromEntries([
      "venomsteel_bar", "venomsteel_core",
      "fire_feather", "fire_bar", "fire_core",
      "tempest_quill", "lightning_bar", "lightning_core",
      "ice_feather", "ice_bar", "ice_core"
    ].map((itemId) => [itemId, INVENTORY_CATALOG[itemId]?.displayName]))).toEqual({
      venomsteel_bar: "Venom Bar",
      venomsteel_core: "Venom Core",
      fire_feather: "Ember Feather",
      fire_bar: "Ember Bar",
      fire_core: "Ember Core",
      tempest_quill: "Tempest Quill",
      lightning_bar: "Storm Bar",
      lightning_core: "Storm Core",
      ice_feather: "Frost Feather",
      ice_bar: "Frost Bar",
      ice_core: "Frost Core"
    });
  });
});

describe("Sulfur catalog", () => {
  it("uses the normal fungible resource stack and economy conventions", () => {
    expect(INVENTORY_CATALOG.sulfur).toMatchObject({
      displayName: "Sulfur",
      description: "A volatile yellow mineral used in explosives and advanced industrial crafting.",
      stackable: true,
      maxStack: 250,
      droppable: true,
      manorStorable: true,
      marketTradable: true,
      marketFungible: true,
      marketIdentity: "sulfur"
    });
  });
});
