import type { DroppedItemSnapshot } from "@ash-atlas/shared";

import {
  clampDroppedItemPickupQuantity,
  droppedItemDisplayName
} from "../droppedItems/droppedItemModel.js";
import { GameActionPrompt } from "./GameActionPrompt.js";
import { ItemArtwork } from "./ItemArtwork.js";

type PickupDroppedItemDialogProps = {
  drop: DroppedItemSnapshot;
  amount: number;
  busy?: boolean;
  onAmountChange(amount: number): void;
  onCancel(): void;
  onConfirm(): void;
};

export function PickupDroppedItemDialog({
  drop,
  amount,
  busy = false,
  onAmountChange,
  onCancel,
  onConfirm
}: PickupDroppedItemDialogProps): React.JSX.Element {
  const name = droppedItemDisplayName(drop);
  const setAmount = (value: number): void => {
    onAmountChange(clampDroppedItemPickupQuantity(value, drop.quantity));
  };

  return <GameActionPrompt
    title={name}
    category="CHOOSE AMOUNT"
    artwork={<ItemArtwork itemId={drop.itemId} variant={drop.variant} label={name} />}
    detail={`${drop.quantity.toLocaleString()} available`}
    elevated
    content={<label className="drop-amount-control">
      <span className="drop-amount-label">
        <span>Quantity</span>
        <strong>{amount.toLocaleString()}</strong>
      </span>
      <input
        className="drop-amount-slider"
        type="range"
        min={1}
        max={drop.quantity}
        step={1}
        value={amount}
        aria-label="Pickup amount slider"
        disabled={busy}
        onChange={(event) => setAmount(Number(event.currentTarget.value))}
      />
      <div className="drop-amount-stepper">
        <button type="button" aria-label="Decrease pickup amount" disabled={busy || amount <= 1} onClick={() => setAmount(amount - 1)}>−</button>
        <input
          type="number"
          min={1}
          max={drop.quantity}
          step={1}
          value={amount}
          aria-label="Pickup amount"
          disabled={busy}
          onChange={(event) => setAmount(Number(event.currentTarget.value))}
        />
        <button type="button" aria-label="Increase pickup amount" disabled={busy || amount >= drop.quantity} onClick={() => setAmount(amount + 1)}>+</button>
      </div>
    </label>}
    actions={[{
      key: "pickup-quantity",
      label: `Take ${amount.toLocaleString()}`,
      enabled: !busy,
      busy,
      onSelect: onConfirm
    }]}
    onCancel={onCancel}
  />;
}
