import { describe, expect, it } from "vitest";

import {
  createPlayerPackageCampaignSchema,
  playerPackageCatalog,
  playerPackageCharacterSearchQuerySchema
} from "./playerPackages.js";

describe("player package asset contracts", () => {
  it("publishes physical assets and explicit virtual currencies without inventory definitions", () => {
    const catalog = playerPackageCatalog();
    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: "balsam_resin",
        kind: "resource",
        assetType: "physical"
      }),
      expect.objectContaining({
        itemId: "gold",
        kind: "gold",
        assetType: "currency"
      }),
      expect.objectContaining({
        itemId: "city_coins",
        kind: "city_coins",
        assetType: "currency"
      }),
      expect.objectContaining({
        itemId: "god_sword",
        kind: "equipment",
        assetType: "physical"
      }),
      expect.objectContaining({
        itemId: "chopping_ring",
        kind: "equipment",
        assetType: "physical"
      }),
      expect.objectContaining({
        itemId: "fishing_rod",
        kind: "resource",
        assetType: "physical",
        stackable: false,
        maxStack: 1
      })
    ]));
    expect(catalog.map((item) => item.itemId)).not.toContain("food");
    expect(catalog.map((item) => item.itemId)).not.toContain("water");
  });

  it("accepts explicit Gold and City Coin lines and rejects mismatched kinds", () => {
    const base = {
      operationKey: "00000000-0000-4000-8000-000000000001",
      targetMode: "specific",
      recipientPlayerIds: ["player"],
      title: "Currencies",
      message: ""
    };
    expect(createPlayerPackageCampaignSchema.safeParse({
      ...base,
      items: [
        { itemKind: "gold", itemId: "gold", quantity: 10 },
        { itemKind: "city_coins", itemId: "city_coins", quantity: 20 }
      ]
    }).success).toBe(true);
    expect(createPlayerPackageCampaignSchema.safeParse({
      ...base,
      items: [{ itemKind: "gold", itemId: "wood", quantity: 10 }]
    }).success).toBe(false);
    expect(createPlayerPackageCampaignSchema.safeParse({
      ...base,
      items: [{
        itemKind: "city_coins",
        itemId: "city_coins",
        variant: "default",
        quantity: 10
      }]
    }).success).toBe(false);
  });

  it("allows blank character browsing and bounded cursor pagination", () => {
    expect(playerPackageCharacterSearchQuerySchema.parse({})).toEqual({
      search: "",
      limit: 25
    });
    expect(playerPackageCharacterSearchQuerySchema.parse({
      search: "",
      cursor: "25"
    })).toEqual({ search: "", cursor: "25", limit: 25 });
  });
});
