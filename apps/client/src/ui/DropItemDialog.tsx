import { useEffect } from "react";
import { clampInventoryDropQuantity, type ActionableInventoryDropSelection } from "../inventory/inventoryPanelModel.js";
import { GameActionPrompt } from "./GameActionPrompt.js";
import { ItemArtwork } from "./ItemArtwork.js";

type DropItemDialogProps = {
  selection: ActionableInventoryDropSelection;
  amount: number;
  busy: boolean;
  manorMode?: boolean;
  onAmountChange(amount: number): void;
  onCancel(): void;
  onConfirm(): void;
};

export function DropItemDialog({ selection, amount, busy, manorMode = false, onAmountChange, onCancel, onConfirm }: DropItemDialogProps): React.JSX.Element {
  const setAmount = (value: number): void => onAmountChange(clampInventoryDropQuantity(value, selection.quantity));
  useEffect(() => {
    if (!busy && amount > selection.quantity) onAmountChange(selection.quantity);
  }, [amount, busy, onAmountChange, selection.quantity]);
  return <GameActionPrompt title={selection.name} category={manorMode ? "Store in Manor" : "Drop from inventory"}
    ariaLabel={`${manorMode ? "Store" : "Drop"} ${selection.name}`} elevated
    artwork={<ItemArtwork itemId={selection.itemId} variant={selection.variant} label={selection.name} />}
    detail={`${selection.quantity.toLocaleString()} available`}
    content={<label className="drop-amount-control">
      <span className="drop-amount-label"><span>Quantity</span><strong>{amount.toLocaleString()}</strong></span>
      <input className="drop-amount-slider" type="range" min={1} max={selection.quantity} step={1} value={amount} disabled={busy}
        aria-label="Drop amount slider" onChange={(event) => setAmount(Number(event.currentTarget.value))} />
      <div className="drop-amount-stepper">
        <button type="button" aria-label="Decrease drop amount" disabled={busy || amount <= 1} onClick={() => setAmount(amount - 1)}>−</button>
        <input type="number" inputMode="numeric" min={1} max={selection.quantity} step={1} value={amount} disabled={busy}
          aria-label="Drop amount" onChange={(event) => setAmount(Number(event.currentTarget.value))} />
        <button type="button" aria-label="Increase drop amount" disabled={busy || amount >= selection.quantity} onClick={() => setAmount(amount + 1)}>+</button>
      </div>
    </label>}
    actions={[{ key: "confirm", label: busy ? manorMode ? "Storing" : "Dropping" : `${manorMode ? "Store" : "Drop"} ${amount.toLocaleString()}`,
      busy, tone: manorMode ? "primary" : "danger", onSelect: onConfirm }]}
    onCancel={onCancel} />;
}
