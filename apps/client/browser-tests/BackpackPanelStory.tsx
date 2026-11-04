import {
  requireBackpackLevel,
  emptyInventoryTotals,
  type BackpackInstanceSnapshot,
  type BackpackSnapshot
} from "@ash-atlas/shared";
import { useState } from "react";

import { BackpackPanel } from "../src/ui/BackpackPanel.js";

export function BackpackPanelStory(): React.JSX.Element {
  const [feedback, setFeedback] = useState<string | null>(null);
  return (
    <BackpackPanel
      open
      layout="phone"
      backpacks={snapshot()}
      inventory={{
        playerId: "browser-player",
        revision: 1,
        items: [],
        totals: { ...emptyInventoryTotals(), leather: 1_000 },
        currentWeightGrams: "72400",
        maximumWeightGrams: "1060000"
      }}
      goldBalance="10000"
      online
      pending={false}
      feedback={feedback}
      onCreate={(slot) => setFeedback(`Craft requested for Backpack ${slot + 1}.`)}
      onEquip={() => undefined}
      onUnequip={() => undefined}
      onUpgrade={() => undefined}
      onClose={() => undefined}
    />
  );
}

function snapshot(): BackpackSnapshot {
  const equipped: BackpackSnapshot["equipped"] = [
    instance("starter", "starter_backpack", 0),
    instance("trailblazer", "trailblazer_backpack", 1),
    null,
    null
  ];
  return {
    playerId: "browser-player",
    revision: 1,
    baseCapacityGrams: 1_000_000,
    backpackBonusGrams: 60_000,
    maximumCapacityGrams: 1_060_000,
    equipped,
    instances: equipped.filter(
      (item): item is BackpackInstanceSnapshot => item !== null
    )
  };
}

function instance(
  instanceId: string,
  definitionId: BackpackInstanceSnapshot["definitionId"],
  equippedSlot: number
): BackpackInstanceSnapshot {
  const upgradeLevel = definitionId === "starter_backpack" ? 0 : 10;
  const level = requireBackpackLevel(upgradeLevel);
  return {
    instanceId,
    ownerPlayerId: "browser-player",
    definitionId,
    displayName: `Backpack +${upgradeLevel}`,
    location: "equipped",
    capacityBonusGrams: level.capacityBonusGrams,
    unitWeightGrams: 0,
    upgradeLevel,
    equippedSlot,
    inventorySlotIndex: null,
    manorId: null,
    manorSlotIndex: null,
    version: 1,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z"
  };
}
