import type { DroppedItemSnapshot } from "@ash-atlas/shared";
import { useEffect, useMemo, useState } from "react";

import {
  droppedItemDisplayName,
  stackDroppedItemPile,
  type DroppedItemInteraction
} from "../droppedItems/droppedItemModel.js";
import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameTargetPicker } from "./GameTargetPicker.js";
import { ItemArtwork } from "./ItemArtwork.js";

type DroppedItemPromptProps = {
  drops: readonly DroppedItemSnapshot[];
  disabled: boolean;
  interaction: DroppedItemInteraction | null;
  onPickupStack(drops: readonly DroppedItemSnapshot[]): void;
  onPickupPile(drops: readonly DroppedItemSnapshot[]): void;
  onChooseAmount(drops: readonly DroppedItemSnapshot[]): void;
  onCancel(): void;
};

export function DroppedItemPrompt({
  drops,
  disabled,
  interaction,
  onPickupStack,
  onPickupPile,
  onChooseAmount,
  onCancel
}: DroppedItemPromptProps): React.JSX.Element | null {
  const orderedDrops = useMemo(() => [...drops].sort((left, right) =>
    (left.pileOrder ?? 0) - (right.pileOrder ?? 0)
    || left.dropId.localeCompare(right.dropId)
  ), [drops]);
  const stacks = useMemo(() => stackDroppedItemPile(orderedDrops), [orderedDrops]);
  const pileQuantity = orderedDrops.reduce((total, drop) => total + drop.quantity, 0);
  const [detailStackKey, setDetailStackKey] = useState<string | null>(null);

  useEffect(() => {
    setDetailStackKey((current) => {
      if (current && stacks.some((stack) => stack.key === current)) return current;
      return stacks.length === 1 && orderedDrops.length === 1 ? stacks[0]!.key : null;
    });
  }, [orderedDrops.length, stacks]);

  if (interaction) return null;
  if (stacks.length === 0) return null;
  const detailStack = stacks.find((stack) => stack.key === detailStackKey)
    ?? (stacks.length === 1 && orderedDrops.length === 1 ? stacks[0]! : null);
  const enabled = !disabled;
  const disabledReason = disabled ? "Pickup is unavailable while disconnected." : null;

  if (!detailStack) {
    return <GameTargetPicker
      ariaLabel="Choose an item"
      title="Choose Item"
      choices={stacks.map((stack) => ({
        key: stack.key,
        name: droppedItemDisplayName(stack.displayDrop),
        category: "Dropped item",
        quickAction: {
          label: `Take All (${stack.displayDrop.quantity.toLocaleString()})`,
          enabled,
          ...(disabledReason ? { disabledReason } : {})
        }
      }))}
      onSelect={setDetailStackKey}
      onQuickAction={(key) => {
        const stack = stacks.find((candidate) => candidate.key === key);
        if (stack) onPickupStack(stack.drops);
      }}
      className="dropped-item-prompt"
      footerAction={{
        label: `Take All (${pileQuantity.toLocaleString()})`,
        enabled,
        ...(disabledReason ? { disabledReason } : {})
      }}
      onFooterAction={() => onPickupPile(orderedDrops)}
      onCancel={onCancel}
    />;
  }

  const detailDrop = detailStack.displayDrop;
  const name = detailDrop.backpack?.displayName ?? droppedItemDisplayName(detailDrop);
  const artworkItemId = detailDrop.backpackInstanceId ? "pack" : detailDrop.itemId;
  // A unique drop (a backpack or one piece of gear) has nothing to split: one full-width Pick Up.
  const unique = Boolean(detailDrop.backpackInstanceId || detailDrop.equipmentInstanceId) && detailStack.drops.length === 1;

  return <GameActionPrompt
    title={name}
    artwork={<ItemArtwork itemId={artworkItemId} variant={detailDrop.variant} label={name} />}
    actions={unique ? [
      {
        key: "pickup",
        label: "Pick Up",
        enabled,
        disabledReason,
        onSelect: () => onPickupStack(detailStack.drops)
      }
    ] : [
      {
        key: "pickup-all",
        label: `Take All (${detailDrop.quantity.toLocaleString()})`,
        enabled,
        disabledReason,
        onSelect: () => onPickupStack(detailStack.drops)
      },
      {
        key: "pickup-some",
        label: "Take Some",
        enabled,
        disabledReason,
        onSelect: () => onChooseAmount(detailStack.drops)
      }
    ]}
    className="dropped-item-prompt"
    onCancel={() => orderedDrops.length > 1 ? setDetailStackKey(null) : onCancel()}
  />;
}
