import { describe, expect, it } from "vitest";
import {
  dungeonChestAssetKey,
  dungeonRewardRollSeed,
  dungeonSeededRoll,
  dungeonTorchChanceBonusPct,
  resolveDungeonChestLoot,
  resolveDungeonChestRarity
} from "./dungeonRolls.js";
import { DUNGEON_CATALOG, dungeonCatalogValidationIssues, type DungeonCatalog, type DungeonRewardTableDefinition } from "./dungeonCatalog.js";

const table: DungeonRewardTableDefinition = { id: "chest_loot", revision: "v1", retired: false, items: [], chestLoot: {
  rarities: (["common", "uncommon", "rare", "epic", "legendary"] as const).map((rarity, index) => ({
    rarity, chance: 20, slots: index + 1, loot: [{ itemId: "coal", weight: 1, minQuantity: 1, maxQuantity: 1 }]
  }))
} };
describe("run-seeded dungeon chest rolls", () => {
  it("keeps retry outcomes stable and applies the selected rarity's slot count", () => {
    const result = resolveDungeonChestLoot(table, "run-1:chest-1");
    expect(resolveDungeonChestLoot(table, "run-1:chest-1")).toEqual(result);
    const rarity = table.chestLoot!.rarities.find((row) => row.rarity === result.rarity)!;
    expect(result.items).toEqual([{ itemId: "coal", quantity: rarity.slots }]);
    expect(new Set(Array.from({ length: 100 }, (_, index) => resolveDungeonChestLoot(table, `run-${index}:chest-1`).rarity)).size).toBe(5);
  });
  it("respects zero-weight rarities and zero/100% chest spawn boundaries", () => {
    const guaranteed = structuredClone(table);
    guaranteed.chestLoot!.rarities.forEach((row) => { row.chance = row.rarity === "legendary" ? 100 : 0; });
    for (let index = 0; index < 100; index++) {
      expect(resolveDungeonChestLoot(guaranteed, `run-${index}`).rarity).toBe("legendary");
      expect(dungeonSeededRoll(`run-${index}`)).toBeGreaterThanOrEqual(0);
      expect(dungeonSeededRoll(`run-${index}`)).toBeLessThan(1);
    }
  });
  it("selects rarity artwork independently while preserving the legacy fallback", () => {
    const authored = structuredClone(table);
    authored.chestLoot!.rarities.find((row) => row.rarity === "rare")!.assetKey =
      DUNGEON_CATALOG.prefabs.find((prefab) => prefab.id === "dungeon_chest")!.assetKey;
    const seed = dungeonRewardRollSeed("run-1", "chest-1", authored);
    const rarity = resolveDungeonChestRarity(authored, seed);
    expect(resolveDungeonChestRarity(authored, seed)).toBe(rarity);
    expect(dungeonChestAssetKey(authored, "rare", "legacy-chest.png"))
      .toBe("apps/client/public/assets/dungeons/shared/chest-closed.png");
    expect(dungeonChestAssetKey(authored, "epic", "legacy-chest.png")).toBe("legacy-chest.png");
  });
  it("blocks malformed rarity totals before publication", () => {
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    catalog.rewardTables.push(structuredClone(table));
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
    catalog.rewardTables.at(-1)!.chestLoot!.rarities[0]!.chance = 19;
    expect(dungeonCatalogValidationIssues(catalog).some((issue) => issue.message.includes("100%"))).toBe(true);
  });
  it("rolls chance items independently, deterministically and at the stated odds", () => {
    const chanceTable: DungeonRewardTableDefinition = { id: "chance", revision: "v1", retired: false,
      items: [{ itemId: "coal", quantity: 2 }],
      chanceItems: [
        { itemId: "iron", chancePct: 100, minQuantity: 2, maxQuantity: 2 },
        { itemId: "ore", chancePct: 40, minQuantity: 1, maxQuantity: 3, torchScaling: true },
        { itemId: "stone", chancePct: 1, minQuantity: 1, maxQuantity: 1 }
      ] };
    const lootAt = (run: number, torchTotal = 1, memberId = "p1") =>
      resolveDungeonChestLoot(chanceTable, `run-${run}`, 0, { torchTotal, memberId });
    expect(lootAt(7)).toEqual(lootAt(7));
    expect(lootAt(7).items).toEqual(expect.arrayContaining([{ itemId: "coal", quantity: 2 }, { itemId: "iron", quantity: 2 }]));
    let ore = 0;
    let boosted = 0;
    for (let run = 0; run < 3_000; run += 1) {
      const base = lootAt(run).items.find((item) => item.itemId === "ore");
      if (base) { ore += 1; expect(base.quantity).toBeGreaterThanOrEqual(1); expect(base.quantity).toBeLessThanOrEqual(3); }
      if (lootAt(run, 5).items.some((item) => item.itemId === "ore")) boosted += 1;
    }
    expect(ore / 3_000).toBeCloseTo(0.4, 1);
    expect(boosted / 3_000).toBeCloseTo(0.6, 1);
    // Members roll independently; unscaled entries ignore torches.
    expect(new Set(Array.from({ length: 40 }, (_, member) =>
      lootAt(1, 1, `p${member}`).items.some((item) => item.itemId === "ore"))).size).toBe(2);
    expect(dungeonTorchChanceBonusPct(3)).toBe(10);
    const guaranteedOnly = { ...chanceTable, chanceItems: [{ itemId: "iron", chancePct: 100, minQuantity: 1, maxQuantity: 1 }] };
    expect(resolveDungeonChestLoot(guaranteedOnly, "x", 0, { torchTotal: 9 }).items.some((item) => item.itemId === "iron")).toBe(true);
  });
  it("applies chance items alongside chest loot and validates their schema", () => {
    const withChest = structuredClone(table);
    withChest.chanceItems = [{ itemId: "iron", chancePct: 100, minQuantity: 1, maxQuantity: 1 }];
    expect(resolveDungeonChestLoot(withChest, "run-1:chest-1").items.map((item) => item.itemId)).toEqual(["coal", "iron"]);
    const catalog = structuredClone(DUNGEON_CATALOG) as DungeonCatalog;
    catalog.rewardTables.push(withChest);
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
    withChest.chanceItems = [{ itemId: "no_such_item", chancePct: 10, minQuantity: 1, maxQuantity: 1 }];
    expect(dungeonCatalogValidationIssues(catalog).some((issue) => issue.path.includes("chanceItems"))).toBe(true);
  });
});
