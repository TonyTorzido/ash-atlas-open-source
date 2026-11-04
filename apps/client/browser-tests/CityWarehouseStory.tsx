import {
  emptyInventoryTotals,
  type CityWarehouseSnapshot,
  type InventoryProtectionSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import {
  CityWarehousePanel,
  type CityWarehouseDonationIntent
} from "../src/ui/CityWarehousePanel.js";

declare global {
  interface Window {
    cityWarehouseActions: Array<Record<string, unknown>>;
  }
}

const warehouseId = "00000000-0000-4000-8000-000000000001";
const woodStackId = "00000000-0000-4000-8000-000000000101";

export function CityWarehouseStory({
  layout
}: {
  layout: "desktop" | "phone";
}): React.JSX.Element {
  const [inventory, setInventory] = useState(inventorySnapshot);
  const [warehouse, setWarehouse] = useState(warehouseSnapshot);
  const [feedback, setFeedback] = useState<string | null>(
    "High Desert City Warehouse opened."
  );
  window.cityWarehouseActions ??= [];

  useEffect(() => {
    document.documentElement.dataset.uiProfile = layout;
    return () => {
      delete document.documentElement.dataset.uiProfile;
    };
  }, [layout]);

  const donate = (donation: CityWarehouseDonationIntent): boolean => {
    window.cityWarehouseActions.push({ action: "donate", ...donation });
    setInventory((current) => ({
      ...current,
      currentWeightGrams: String(BigInt(current.currentWeightGrams ?? "2000") - BigInt(donation.quantity * 100)),
      items: current.items
        .map((item) => item.stackId === donation.stackId
          ? { ...item, quantity: item.quantity - donation.quantity }
          : item)
        .filter((item) => item.quantity > 0),
      totals: {
        ...current.totals,
        wood: current.totals.wood - donation.quantity
      }
    }));
    setWarehouse((current) => ({
      ...current,
      usedSlots: current.usedSlots + 1,
      revision: String(Number(current.revision) + 1),
      stacks: [...current.stacks, {
        stackId: "00000000-0000-4000-8000-000000000203",
        slotIndex: 5,
        itemId: "wood",
        variant: null,
        quantity: donation.quantity,
        version: "1"
      }]
    }));
    setFeedback(
      `Donated ${donation.quantity.toLocaleString()} ${donation.displayName} to the City Warehouse.`
    );
    return true;
  };

  return (
    <div style={{ width: "100vw", height: "100vh", container: "mobile-app / size" }}>
      <CityWarehousePanel
        open
        warehouse={warehouse}
        activeWarehouseStructureId={warehouseId}
        inventory={inventory}
        protection={protectionSnapshot()}
        online
        pending={false}
        feedback={feedback}
        error={null}
        walletGold="1000"
        layout={layout}
        onDonate={donate}
        onDonateAll={() => {
          window.cityWarehouseActions.push({ action: "donate-all" });
          return true;
        }}
        onDonateGold={(amount) => {
          window.cityWarehouseActions.push({ action: "donate-gold", amount });
          return true;
        }}
        onMove={() => true}


        onClose={() => undefined}
      />
    </div>
  );
}

function inventorySnapshot(): PlayerInventorySnapshot {
  return {
    playerId: "browser-player",
    revision: 0,
    items: [{
      playerId: "browser-player",
      resourceType: "wood",
      variant: null,
      quantity: 20,
      stackId: woodStackId,
      slotIndex: 0,
      manualSplit: false
    }],
    currentWeightGrams: "2000",
    maximumWeightGrams: "100000",
    totals: { ...emptyInventoryTotals(), wood: 20 }
  };
}

function protectionSnapshot(): InventoryProtectionSnapshot {
  return {
    playerId: "browser-player",
    revision: 1,
    materialPolicies: [],
    uniqueItems: [],
    stackAllocations: [{
      stackId: woodStackId,
      itemId: "wood",
      variant: null,
      protectedQuantity: 0,
      movableQuantity: 20,
      status: "none",
      reason: null
    }]
  };
}

function warehouseSnapshot(): CityWarehouseSnapshot {
  return {
    cityId: "00000000-0000-4000-8000-000000000002",
    structureId: warehouseId,
    cityName: "High Desert",
    tier: 1,
    usedSlots: 2,
    totalSlots: 60,
    revision: "2",
    canReorganize: false,
    gold: {
      balance: "0", capacity: "30000", remainingCapacity: "30000",
      lifetimeDonated: "0", lifetimeSpent: "0", revision: "0",
      canDonate: true, recentDonations: []
    },
    stacks: [{
      stackId: "00000000-0000-4000-8000-000000000201",
      slotIndex: 0,
      itemId: "stone",
      variant: null,
      quantity: 12,
      version: "1"
    }, {
      stackId: "00000000-0000-4000-8000-000000000202",
      slotIndex: 3,
      itemId: "balsam_resin",
      variant: null,
      quantity: 4,
      version: "1"
    }]
  };
}
