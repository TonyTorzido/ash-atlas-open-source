import {
  emptyInventoryTotals,
  type EquipmentSnapshotV2,
  type InventoryProtectionSnapshot,
  type PlayerInventorySnapshot,
  type ResourceType
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { InventoryPanel } from "../src/ui/InventoryPanel.js";
import { InventoryProtectionPanel } from "../src/ui/InventoryProtectionPanel.js";

declare global {
  interface Window {
    itemProtectionSaves: Array<{
      itemId: ResourceType;
      variant: string | null;
      quantity: number;
      revision: number;
    }>;
  }
}

type View = "inventory" | "protection";

export function ItemProtectionRoutesStory({
  layout = "phone"
}: {
  layout?: "desktop" | "phone";
}): React.JSX.Element {
  const [view, setView] = useState<View>("inventory");
  const [protection, setProtection] = useState<InventoryProtectionSnapshot>(
    () => protectionSnapshot()
  );
  const inventory = inventorySnapshot();
  window.itemProtectionSaves ??= [];

  useEffect(() => {
    document.documentElement.dataset.uiProfile = layout;
    return () => {
      delete document.documentElement.dataset.uiProfile;
    };
  }, [layout]);

  const saveMaterial = (
    itemId: ResourceType,
    variant: string | null,
    quantity: number,
    revision: number
  ): boolean => {
    window.itemProtectionSaves.push({ itemId, variant, quantity, revision });
    setProtection((current) => ({
      ...current,
      revision: current.revision + 1,
      materialPolicies: current.materialPolicies.map((policy) =>
        policy.itemId === itemId && policy.variant === variant
          ? { ...policy, keepQuantity: quantity }
          : policy
      )
    }));
    return true;
  };

  if (view === "protection") {
    return (
      <InventoryProtectionPanel
        open
        protection={protection}
        inventory={inventory}
        equipment={equipmentSnapshot()}
        online
        busy={false}
        layout={layout}
        onSetMaterialKeep={saveMaterial}
        onSetUnique={(equipmentInstanceId, protectedValue) => {
          setProtection((current) => ({
            ...current,
            revision: current.revision + 1,
            uniqueItems: current.uniqueItems.map((item) =>
              item.equipmentInstanceId === equipmentInstanceId
                ? { ...item, protected: protectedValue }
                : item
            )
          }));
          return true;
        }}
        onClose={() => setView("inventory")}
      />
    );
  }
  return (
    <InventoryPanel
      open
      inventory={inventory}
      equipment={null}
      protection={protection}
      hasSnapshot
      connectionStatus="online"
      droppingItemKey={null}
      layout={layout}
      onChooseDrop={() => undefined}

      onOpenProtection={() => setView("protection")}
      onClose={() => undefined}
    />
  );
}

function inventorySnapshot(): PlayerInventorySnapshot {
  return {
    playerId: "browser-player",
    revision: 0,
    items: [{
      playerId: "browser-player",
      resourceType: "leather",
      variant: "tanned",
      quantity: 120,
      stackId: "00000000-0000-4000-8000-000000000101",
      slotIndex: 0,
      manualSplit: false
    }],
    currentWeightGrams: "40000",
    maximumWeightGrams: "100000",
    totals: { ...emptyInventoryTotals(), leather: 120 }
  };
}

function protectionSnapshot(): InventoryProtectionSnapshot {
  return {
    playerId: "browser-player",
    revision: 7,
    materialPolicies: [{
      itemId: "leather",
      variant: "tanned",
      keepQuantity: 2,
      currentTotal: 120
    }],
    uniqueItems: [
      { equipmentInstanceId: "editable", protected: false, systemReason: null },
      {
        equipmentInstanceId: "system",
        protected: true,
        systemReason: "Equipped items cannot be stored"
      }
    ],
    stackAllocations: []
  };
}

function equipmentSnapshot(): EquipmentSnapshotV2 {
  return {
    playerId: "browser-player",
    instances: [
      {
        instanceId: "editable",
        displayName: "Bronze Axe",
        itemLevel: 2,
        location: "inventory"
      },
      {
        instanceId: "system",
        displayName: "Equipped Spear",
        itemLevel: 3,
        location: "equipped"
      }
    ]
  } as EquipmentSnapshotV2;
}
