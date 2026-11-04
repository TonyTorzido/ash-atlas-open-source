import {
  INVENTORY_CATALOG,
  ANIMAL_MOB_ARCHETYPES,
  INVENTORY_ITEM_GROUP_IDS,
  INVENTORY_ITEM_TYPES,
  MOB_DROP_ITEMS,
  MOB_DROP_ITEM_IDS,
  UNIVERSAL_FOOD_BY_MOB,
  emptyInventoryTotals,
  getItemWeightGrams,
  projectEffectiveInventoryProtection,
  type BackpackInstanceSnapshot
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  INVENTORY_ITEM_GROUP_NAMES,
  InventoryDropRequestGate,
  clampInventoryDropQuantity,
  groupBackpackInstances,
  inventoryDropSelection,
  inventoryDropFeedback,
  inventoryItemGroup,
  inventoryPanelRows,
  inventoryPanelTransitionForKey,
  nextInventoryPanelOpen,
  normalizeInventorySnapshot,
  resolveInventoryDropSelection,
  shouldAcceptInventorySnapshot
} from "./inventoryPanelModel.js";

describe("inventory panel model", () => {
  it("puts every existing item in the group its id suffix gave it before groups moved to the catalog", () => {
    // The id matching that groups replaced (2026-10-04); kept here only to pin parity.
    const SUFFIX_GROUPS: readonly [string, RegExp][] = [
      ["meat", /(_cut|_legs|_meat|_tail)$/],
      ["hides", /(_hide|_pelt)$/],
      ["feathers", /(_feather|_quill)$/],
      ["bars", /(_bar|_core)$/],
      ["ores", /^(stone|ore|iron|coal|sulfur|crystal|slag)$/],
      ["food", /^(simple_food|food|giving_berry|produce|field_ration|hearty_ration|elemental_ration)$/]
    ];
    // Wave 1 cuts came after the move and declare meat or fish on the catalog.
    const wave1Cuts = new Set<string>([...ANIMAL_MOB_ARCHETYPES, "mammoth_patriarch" as const]
      .flatMap((key) => UNIVERSAL_FOOD_BY_MOB[key]?.itemId ?? []));
    expect(wave1Cuts.size).toBe(61);
    for (const itemId of wave1Cuts) {
      expect(inventoryItemGroup(itemId)?.id, itemId).toMatch(/^(meat|fish)$/u);
    }
    // The overworld bestiary's own cuts declare meat on the catalog too.
    const bestiaryCuts = new Set<string>(["dire_wolf_cut", "drake_cut", "dragon_cut", "grub_meat"]);
    for (const itemId of bestiaryCuts) expect(inventoryItemGroup(itemId)?.id, itemId).toBe("meat");
    // Water game phase B items also declare their group on the catalog.
    expect(inventoryItemGroup("shellback_plate")?.id).toBe("scales");
    expect(inventoryItemGroup("abyssal_orb")?.id).toBe("essences");
    // The Wyrm Hollow's egg declares its group on the catalog too.
    expect(inventoryItemGroup("wyrm_egg")?.id).toBe("eggs");
    expect(inventoryItemGroup("dragon_scale")?.id).toBe("scales");
    // Mob value drops (mobDropItems.ts) also came after the move and declare their group.
    for (const itemId of MOB_DROP_ITEM_IDS) {
      expect(inventoryItemGroup(itemId)?.id ?? null, itemId).toBe(MOB_DROP_ITEMS[itemId].group);
    }
    const mobDrops = new Set<string>(MOB_DROP_ITEM_IDS);
    const ids = new Set<string>([...Object.keys(INVENTORY_CATALOG), ...INVENTORY_ITEM_TYPES]);
    let grouped = 0;
    for (const itemId of ids) {
      if (wave1Cuts.has(itemId) || bestiaryCuts.has(itemId) || mobDrops.has(itemId) || itemId === "shellback_plate" || itemId === "abyssal_orb" || itemId === "wyrm_egg" || itemId === "dragon_scale") continue;
      const suffixGroup = SUFFIX_GROUPS.find(([, match]) => match.test(itemId))?.[0] ?? null;
      expect({ itemId, group: inventoryItemGroup(itemId)?.id ?? null }).toEqual({ itemId, group: suffixGroup });
      if (suffixGroup) grouped += 1;
    }
    expect(grouped).toBe(84);
    expect(inventoryItemGroup("deer_cut")).toEqual({ id: "meat", name: "Meat" });
    expect(inventoryItemGroup("ore")).toEqual({ id: "ores", name: "Ores and minerals" });
    expect(Object.keys(INVENTORY_ITEM_GROUP_NAMES).sort()).toEqual([...INVENTORY_ITEM_GROUP_IDS].sort());
  });

  it("groups every matching backpack instance without imposing a display cap", () => {
    const backpacks = Array.from({ length: 32 }, (_, index) => ({
      ...backpack(),
      instanceId: `backpack-${index}`
    }));

    const groups = groupBackpackInstances(backpacks);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.quantity).toBe(32);
    expect(groups[0]?.instanceIds).toEqual(backpacks.map(({ instanceId }) => instanceId));
  });

  it("does not group backpacks with different identity, location, upgrade, or capacity metadata", () => {
    const sameCapacityDifferentDefinition = {
      ...backpack(),
      instanceId: "different-definition",
      definitionId: "trailblazer_backpack" as const,
      displayName: "Trailblazer Backpack +10"
    };
    const differentUpgrade = {
      ...backpack(),
      instanceId: "different-upgrade",
      displayName: "Backpack +9",
      upgradeLevel: 9,
      capacityBonusGrams: 50_000
    };
    const differentCapacity = {
      ...backpack(),
      instanceId: "different-capacity",
      capacityBonusGrams: 60_000
    };
    expect(groupBackpackInstances([
      backpack(),
      sameCapacityDifferentDefinition,
      differentUpgrade,
      differentCapacity
    ])).toHaveLength(4);
  });

  it("stacks backpacks that show the same row even when hidden fields differ", () => {
    const leftoverManorId = { ...backpack(), instanceId: "was-in-manor", manorId: "manor-1" };
    const otherWeight = { ...backpack(), instanceId: "legacy-weight", unitWeightGrams: 1 };
    const noCapacityField = { ...backpack(), instanceId: "legacy-capacity", capacityBonusGrams: undefined };
    expect(groupBackpackInstances([backpack(), leftoverManorId, otherWeight, noCapacityField])
      .map(({ quantity }) => quantity)).toEqual([4]);
  });

  it("stacks same-level backpacks, but merges equipped with carried, keeps other levels separate", () => {
    const same = [backpack(), { ...backpack(), instanceId: "second" }];
    expect(groupBackpackInstances(same).map(({ quantity }) => quantity)).toEqual([2]);
    const lower = { ...backpack(), instanceId: "lower", displayName: "Backpack +9", upgradeLevel: 9, capacityBonusGrams: 50_000 };
    expect(groupBackpackInstances([...same, lower]).map(({ quantity }) => quantity)).toEqual([2, 1]);
    const equipped = { ...backpack(), instanceId: "worn", location: "equipped" as const, equippedSlot: 0 };
    const merged = groupBackpackInstances([equipped, ...same]);
    expect(merged.map(({ quantity }) => quantity)).toEqual([3]);
    expect(merged[0]?.item.instanceId).toBe([equipped, ...same].map(({ instanceId }) => instanceId).sort()[0]);
  });

  it("preserves exact authoritative grams and entry identity without a gameplay stack cap", () => {
    const inventory = normalizeInventorySnapshot({ playerId: "p", revision: 7,
      currentWeightGrams: "900719925474099300", maximumWeightGrams: "900719925474099400",
      items: [{ resourceType: "wood", variant: null, entryId: "balance-wood", stackId: "balance-wood", quantity: 4370, maxStack: 64, unitWeightGrams: 100, totalWeightGrams: "437000" }]
    }, "p");
    expect(inventory.currentWeightGrams).toBe("900719925474099300");
    expect(inventory.maximumWeightGrams).toBe("900719925474099400");
    const row = inventoryPanelRows(inventory)[0]!;
    expect(row.stackId).toBe("balance-wood");
    expect(row.totalWeightGrams).toBe("437000");
    const protection = { playerId: "p", revision: 1, materialPolicies: [], uniqueItems: [], stackAllocations: [{ stackId: "balance-wood", itemId: "wood", variant: null, protectedQuantity: 0, movableQuantity: 4370, status: "none" as const, reason: null }] };
    expect(resolveInventoryDropSelection(inventoryDropSelection(row)!, inventory, protection)?.quantity).toBe(4370);
  });

  it("opens, closes, and toggles with local UI transitions", () => {
    expect(nextInventoryPanelOpen(false, "open")).toBe(true);
    expect(nextInventoryPanelOpen(true, "close")).toBe(false);
    expect(nextInventoryPanelOpen(false, "toggle")).toBe(true);
    expect(nextInventoryPanelOpen(true, "toggle")).toBe(false);
  });

  it("maps Escape to close and I to toggle", () => {
    expect(inventoryPanelTransitionForKey("Escape")).toBe("close");
    expect(inventoryPanelTransitionForKey("i")).toBe("toggle");
    expect(inventoryPanelTransitionForKey("I")).toBe("toggle");
    expect(inventoryPanelTransitionForKey("f")).toBeNull();
  });

  it("shows authoritative slot stacks and removes zero quantities", () => {
    const snapshot = normalizeInventorySnapshot(
      {
        playerId: "player-1",
        items: [
          {
            playerId: "player-1",
            resourceType: "wood",
            variant: null,
            quantity: 12,
            stackId: "00000000-0000-4000-8000-000000000001",
            slotIndex: 3,
            manualSplit: true
          },
          { playerId: "player-1", resourceType: "water", variant: "fresh", quantity: 0 }
        ],
        totals: { ...emptyInventoryTotals(), wood: 12 }
      },
      "fallback"
    );

    expect(inventoryPanelRows(snapshot)).toEqual([
      {
        key: "00000000-0000-4000-8000-000000000001",
        stackId: "00000000-0000-4000-8000-000000000001",
        slotIndex: 3,
        itemId: "wood",
        variant: null,
        name: "Wood",
        rarity: "common",
        quantity: 12,
        unitWeightGrams: getItemWeightGrams("wood"),
        totalWeightGrams: String(12 * getItemWeightGrams("wood")),
        maxStack: 500,
        canDrop: true,
        canUse: false,
        manualSplit: true
      }
    ]);
  });

  it("exposes both bucket use and drop actions without treating Gardening Bucket as river-fill equipment", () => {
    const snapshot = normalizeInventorySnapshot({
      playerId: "player-1",
      items: [
        { resourceType: "gardening_bucket", quantity: 1, entryId: "gardening-bucket" },
        { resourceType: "water_bucket", quantity: 1, entryId: "water-bucket" }
      ],
      totals: { ...emptyInventoryTotals(), gardening_bucket: 1, water_bucket: 1 }
    }, "player-1");
    const rows = inventoryPanelRows(snapshot);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.canUse && row.canDrop)).toBe(true);
  });

  it("reflects a replacement server snapshot while the panel remains open", () => {
    const first = normalizeInventorySnapshot(
      {
        items: [{ resourceType: "stone", quantity: 1 }],
        totals: { ...emptyInventoryTotals(), stone: 1 }
      },
      "player-1"
    );
    const updated = normalizeInventorySnapshot(
      {
        items: [{ resourceType: "stone", quantity: 3 }],
        totals: { ...emptyInventoryTotals(), stone: 3 }
      },
      "player-1"
    );

    expect(inventoryPanelRows(first)[0]?.quantity).toBe(1);
    expect(inventoryPanelRows(updated)[0]?.quantity).toBe(3);
  });

  it("rejects stale inventory revisions and treats equal replays as idempotent", () => {
    const completedMining = normalizeInventorySnapshot({
      playerId: "player-1",
      revision: 2,
      items: [{ resourceType: "stone", quantity: 1 }],
      totals: { ...emptyInventoryTotals(), stone: 1 }
    }, "player-1");
    const delayedBootstrap = normalizeInventorySnapshot({
      playerId: "player-1",
      revision: 1,
      items: [],
      totals: emptyInventoryTotals()
    }, "player-1");

    expect(shouldAcceptInventorySnapshot(completedMining, "player-1", 1)).toBe(true);
    expect(shouldAcceptInventorySnapshot(delayedBootstrap, "player-1", 2)).toBe(false);
    expect(shouldAcceptInventorySnapshot(completedMining, "player-1", 2)).toBe(false);
    expect(shouldAcceptInventorySnapshot(completedMining, "other-player", -1)).toBe(false);
  });

  it("clamps drop amounts to whole values between one and the owned quantity", () => {
    expect(clampInventoryDropQuantity(-5, 8)).toBe(1);
    expect(clampInventoryDropQuantity(0, 8)).toBe(1);
    expect(clampInventoryDropQuantity(3.9, 8)).toBe(3);
    expect(clampInventoryDropQuantity(99, 8)).toBe(8);
    expect(clampInventoryDropQuantity(Number.NaN, 8)).toBe(1);
  });

  it("creates a locked drop selection only for an owned droppable stack", () => {
    const rows = inventoryPanelRows(
      normalizeInventorySnapshot(
        {
          items: [
            { resourceType: "wood", quantity: 4, stackId: "wood-stack" },
            { resourceType: "mystery", quantity: 2 }
          ],
          totals: { ...emptyInventoryTotals(), wood: 4 }
        },
        "player-1"
      )
    );

    expect(inventoryDropSelection(rows.find((row) => row.itemId === "wood")!)).toMatchObject({
      itemId: "wood",
      name: "Wood",
      stackId: "wood-stack"
    });
    expect(inventoryDropSelection(rows.find((row) => row.itemId === "mystery")!)).toBeNull();
  });

  it("re-resolves a selected stack against current inventory and effective protection", () => {
    const currentInventory = normalizeInventorySnapshot({
      playerId: "player-1",
      items: [
        { resourceType: "wood", quantity: 250, stackId: "wood-250", slotIndex: 0 },
        { resourceType: "wood", quantity: 41, stackId: "wood-41", slotIndex: 1 }
      ],
      totals: { ...emptyInventoryTotals(), wood: 291 }
    }, "player-1");
    const selected = inventoryDropSelection(
      inventoryPanelRows(currentInventory)[0]!
    )!;
    const stalePolicy = {
      playerId: "player-1",
      revision: 1,
      materialPolicies: [],
      uniqueItems: [],
      stackAllocations: [{
        stackId: "wood-250",
        itemId: "wood",
        variant: null,
        protectedQuantity: 209,
        movableQuantity: 41,
        status: "partial" as const,
        reason: "stale"
      }]
    };

    expect(resolveInventoryDropSelection(
      selected,
      currentInventory,
      projectEffectiveInventoryProtection(stalePolicy, currentInventory)
    )?.quantity).toBe(250);
    const keep41 = projectEffectiveInventoryProtection({
      ...stalePolicy,
      materialPolicies: [{
        itemId: "wood",
        variant: null,
        keepQuantity: 41,
        currentTotal: 41
      }]
    }, currentInventory);
    expect(resolveInventoryDropSelection(selected, currentInventory, keep41)?.quantity)
      .toBe(209);
    expect(resolveInventoryDropSelection(
      inventoryDropSelection(inventoryPanelRows(currentInventory)[1]!)!,
      currentInventory,
      keep41
    )?.quantity).toBe(41);
    expect(resolveInventoryDropSelection(selected, {
      ...currentInventory,
      items: currentInventory.items.slice(1)
    }, keep41)).toBeNull();
  });

  it("uses a readable fallback for unknown items", () => {
    const snapshot = normalizeInventorySnapshot(
      {
        items: [{ resourceType: "crystal_shard", quantity: 2 }],
        totals: emptyInventoryTotals()
      },
      "player-1"
    );

    expect(inventoryPanelRows(snapshot)[0]).toMatchObject({
      name: "Crystal Shard",
      quantity: 2,
      canDrop: false
    });
  });

  it("names Enchantment Stone variants and keeps them droppable but not usable", () => {
    const snapshot = normalizeInventorySnapshot(
      {
        items: [{ resourceType: "enchantment_stone", variant: "diamond", quantity: 1 }],
        totals: { ...emptyInventoryTotals(), enchantment_stone: 1 }
      },
      "player-1"
    );

    expect(inventoryPanelRows(snapshot)[0]).toMatchObject({
      name: "Diamond Enchantment Stone",
      quantity: 1,
      canDrop: true,
      canUse: false
    });
  });

  it("allows only one in-flight drop request", () => {
    const gate = new InventoryDropRequestGate();

    expect(gate.begin("wood:default")).toBe(true);
    expect(gate.begin("wood:default")).toBe(false);
    expect(gate.begin("stone:default")).toBe(false);
    expect(gate.finish()).toBe("wood:default");
    expect(gate.begin("stone:default")).toBe(true);
  });

  it("uses server drop feedback with a stable fallback", () => {
    expect(inventoryDropFeedback(" Dropped Wood x1. ")).toBe("Dropped Wood x1.");
    expect(inventoryDropFeedback(null)).toBe("Item dropped.");
  });

  it("turns malformed snapshots into a safe empty snapshot", () => {
    expect(normalizeInventorySnapshot({ items: "bad", totals: null }, "player-1")).toEqual({
      playerId: "player-1",
      revision: 0,
      items: [],
      totals: emptyInventoryTotals(),
      currentWeightGrams: "0",
      maximumWeightGrams: "1000000"
    });
  });
});

function backpack(): BackpackInstanceSnapshot {
  return {
    instanceId: "backpack-base",
    ownerPlayerId: "player-1",
    definitionId: "starter_backpack",
    displayName: "Backpack +10",
    location: "inventory",
    upgradeLevel: 10,
    capacityBonusGrams: 55_000,
    unitWeightGrams: 0,
    equippedSlot: null,
    inventorySlotIndex: null,
    manorId: null,
    manorSlotIndex: null,
    version: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z"
  };
}
