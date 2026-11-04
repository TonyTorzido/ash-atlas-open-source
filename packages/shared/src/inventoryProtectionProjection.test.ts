import { describe, expect, it } from "vitest";

import { emptyInventoryTotals, type PlayerInventorySnapshot } from "./collectibles.js";
import type { EquipmentInstanceV2, EquipmentSnapshotV2 } from "./equipment.js";
import type { InventoryProtectionSnapshot, MaterialKeepPolicy } from "./inventoryProtection.js";
import {
  projectEffectiveInventoryProtection,
  projectMaterialProtection
} from "./inventoryProtectionProjection.js";

describe("inventory protection projection", () => {
  it("ignores stale allocations and makes current stacks fully movable without a keep policy", () => {
    const effective = projectEffectiveInventoryProtection(
      policySnapshot({
        stackAllocations: [{
          stackId: "wood-250",
          itemId: "wood",
          variant: null,
          protectedQuantity: 209,
          movableQuantity: 41,
          status: "partial",
          reason: "stale"
        }]
      }),
      inventory(
        stack("wood-250", "wood", null, 250, 0),
        stack("wood-41", "wood", null, 41, 1)
      )
    );

    expect(effective.stackAllocations).toMatchObject([
      { stackId: "wood-250", protectedQuantity: 0, movableQuantity: 250 },
      { stackId: "wood-41", protectedQuantity: 0, movableQuantity: 41 }
    ]);
  });

  it("allocates Keep 41 by deterministic slot order", () => {
    const projected = projectMaterialProtection(
      inventory(
        stack("wood-250", "wood", null, 250, 0),
        stack("wood-41", "wood", null, 41, 1)
      ),
      [policy("wood", null, 41)]
    );

    expect(projected.materialPolicies).toEqual([
      { itemId: "wood", variant: null, keepQuantity: 41, currentTotal: 291 }
    ]);
    expect(projected.stackAllocations).toMatchObject([
      { stackId: "wood-250", protectedQuantity: 41, movableQuantity: 209 },
      { stackId: "wood-41", protectedQuantity: 0, movableQuantity: 41 }
    ]);
  });

  it("spans stacks, isolates variants, and includes manual splits", () => {
    const projected = projectMaterialProtection(
      inventory(
        { ...stack("wood-b", "wood", null, 25, 2), manualSplit: true },
        stack("wood-a", "wood", null, 50, 1),
        stack("wood-oak", "wood", "oak", 80, 0)
      ),
      [
        policy("wood", null, 60),
        policy("wood", "oak", 10)
      ]
    );

    expect(projected.stackAllocations).toMatchObject([
      { stackId: "wood-a", protectedQuantity: 50, movableQuantity: 0 },
      { stackId: "wood-b", protectedQuantity: 10, movableQuantity: 15 },
      { stackId: "wood-oak", protectedQuantity: 10, movableQuantity: 70 }
    ]);
  });

  it("reallocates deterministically after a move and retains absent policies at zero", () => {
    const policies = [
      policy("wood", null, 30),
      policy("stone", null, 12)
    ];
    const before = projectMaterialProtection(
      inventory(
        stack("wood-a", "wood", null, 20, 0),
        stack("wood-b", "wood", null, 20, 1)
      ),
      policies
    );
    const after = projectMaterialProtection(
      inventory(
        stack("wood-a", "wood", null, 20, 1),
        stack("wood-b", "wood", null, 20, 0)
      ),
      policies
    );

    expect(before.stackAllocations).toMatchObject([
      { stackId: "wood-a", protectedQuantity: 20 },
      { stackId: "wood-b", protectedQuantity: 10 }
    ]);
    expect(after.stackAllocations).toMatchObject([
      { stackId: "wood-b", protectedQuantity: 20 },
      { stackId: "wood-a", protectedQuantity: 10 }
    ]);
    expect(after.materialPolicies).toContainEqual({
      itemId: "stone",
      variant: null,
      keepQuantity: 12,
      currentTotal: 0
    });
  });

  it("rejects aggregate totals that cannot be represented safely on the protocol", () => {
    expect(() => projectMaterialProtection(
      inventory(
        stack("wood-a", "wood", null, Number.MAX_SAFE_INTEGER, 0),
        stack("wood-b", "wood", null, 1, 1)
      ),
      [policy("wood", null, 1)]
    )).toThrow("material current total exceeds the safe integer range");
  });

  it("rebuilds unique equipment state while preserving explicit protection", () => {
    const effective = projectEffectiveInventoryProtection(
      policySnapshot({
        uniqueItems: [
          { equipmentInstanceId: "protected", protected: true, systemReason: null },
          { equipmentInstanceId: "destroyed", protected: true, systemReason: null }
        ]
      }),
      inventory(),
      equipment(
        equipmentItem("protected"),
        equipmentItem("new-item"),
        equipmentItem("equipped", { location: "equipped" }),
        equipmentItem("stored", { location: "manor_storage" }),
        equipmentItem("kit", { savedKitIndices: [1] }),
        equipmentItem("unstorable", { manorStorable: false })
      )
    );

    expect(effective.uniqueItems).toEqual([
      { equipmentInstanceId: "equipped", protected: false, systemReason: "Equipped — cannot be stored" },
      { equipmentInstanceId: "kit", protected: false, systemReason: "Referenced by a saved combat kit" },
      { equipmentInstanceId: "new-item", protected: false, systemReason: null },
      { equipmentInstanceId: "protected", protected: true, systemReason: null },
      { equipmentInstanceId: "stored", protected: false, systemReason: "Already stored in Manor Storage" },
      { equipmentInstanceId: "unstorable", protected: false, systemReason: "This item cannot be stored" }
    ]);
  });

  it("updates unequip and cleared-kit reasons and retains policy presentation before equipment arrives", () => {
    const snapshot = policySnapshot({
      uniqueItems: [{
        equipmentInstanceId: "item",
        protected: true,
        systemReason: "Equipped — cannot be stored"
      }]
    });
    expect(
      projectEffectiveInventoryProtection(snapshot, inventory()).uniqueItems
    ).toEqual(snapshot.uniqueItems);
    expect(
      projectEffectiveInventoryProtection(
        snapshot,
        inventory(),
        equipment(equipmentItem("item", {
          location: "inventory",
          savedKitIndices: []
        }))
      ).uniqueItems
    ).toEqual([{
      equipmentInstanceId: "item",
      protected: true,
      systemReason: null
    }]);
  });
});

function inventory(
  ...items: PlayerInventorySnapshot["items"]
): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    items,
    totals: emptyInventoryTotals(),
    unlockedSlots: 16,
    revision: 0
  };
}

function stack(
  stackId: string,
  resourceType: PlayerInventorySnapshot["items"][number]["resourceType"],
  variant: string | null,
  quantity: number,
  slotIndex: number
): PlayerInventorySnapshot["items"][number] {
  return {
    playerId: "player-1",
    resourceType,
    variant,
    quantity,
    stackId,
    slotIndex,
    manualSplit: false
  };
}

function policy(
  itemId: string,
  variant: string | null,
  keepQuantity: number
): MaterialKeepPolicy {
  return { itemId, variant, keepQuantity, currentTotal: 999 };
}

function policySnapshot(
  overrides: Partial<InventoryProtectionSnapshot> = {}
): InventoryProtectionSnapshot {
  return {
    playerId: "player-1",
    revision: 3,
    materialPolicies: [],
    uniqueItems: [],
    stackAllocations: [],
    ...overrides
  };
}

function equipment(
  ...instances: EquipmentInstanceV2[]
): EquipmentSnapshotV2 {
  return {
    playerId: "player-1",
    instances
  } as EquipmentSnapshotV2;
}

function equipmentItem(
  instanceId: string,
  overrides: Partial<EquipmentInstanceV2> = {}
): EquipmentInstanceV2 {
  return {
    instanceId,
    location: "inventory",
    inventorySlotIndex: undefined,
    savedKitIndices: [],
    manorStorable: true,
    ...overrides
  } as EquipmentInstanceV2;
}
