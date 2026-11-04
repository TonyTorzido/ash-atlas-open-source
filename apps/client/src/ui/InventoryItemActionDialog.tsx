import { formatWeightKg, type GearScrollMemoryGroup, type GearScrollsSnapshot } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import type { InventoryPanelRow } from "../inventory/inventoryPanelModel.js";
import { GameActionPrompt, type GamePromptAction } from "./GameActionPrompt.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { ItemRarityLabel } from "./ItemRarityLabel.js";
import { ShopProvenanceDetails } from "./ShopProvenance.js";

type Props = {
  item: InventoryPanelRow;
  /** Open straight on the Details of a tagged copy (long-press). */
  startInDetails?: boolean;
  online: boolean;
  manorMode: boolean;
  surfaceLabel?: string;
  showInventoryActions?: boolean;
  /** Only physical storage stacks support splitting; carried balances never do. */
  showStackActions?: boolean;
  hasEmptySlot?: boolean;
  transferAction?: {
    label: string;
    allLabel: string;
    maximumQuantity?: number;
    disabledReason?: string | null;
    onQuantity(quantity: number): boolean;
  };
  onUse?(): boolean;
  /** Giving Berry and Giving Tree Sapling: plant at the player's position. */
  onPlant?(): boolean;
  onFish?(): boolean;
  /** Manor skin: this skin is the one equipped on the owner's Manor. */
  skinEquipped?: boolean;
  /** Manor skin: equip it on the owner's Manor (it stays in the inventory). */
  onEquipSkin?(): boolean;
  /** Manor skin: back to the default Timber Manor. */
  onUnequipSkin?(): boolean;
  /** Loadout Scroll: the carried scrolls, their memory and the three scroll actions. */
  gearScrolls?: Readonly<{
    snapshot: GearScrollsSnapshot;
    onRemember(position: number, group: GearScrollMemoryGroup): boolean;
    onEquip(position: number): boolean;
  }> | undefined;
  onSplit?(quantity: number): boolean;
  onDrop?(): void;
  dropDisabledReason?: string | null;
  onRestack?(): boolean;
  onClose(): void;
};

export function InventoryItemActionDialog({ item, startInDetails = false, online, manorMode, surfaceLabel = "Inventory item",
  showInventoryActions = true, showStackActions = false, transferAction,
  onUse, onPlant, onFish, skinEquipped = false, onEquipSkin, onUnequipSkin, gearScrolls, onSplit, onDrop, dropDisabledReason, onRestack, onClose
}: Props): React.JSX.Element {
  const [mode, setMode] = useState<"actions" | "transfer" | "split" | "details">(startInDetails && item.provenance ? "details" : "actions");
  const [scrollPosition, setScrollPosition] = useState(gearScrolls?.snapshot.lastEquippedPosition ?? 1);
  const scroll = item.itemId === "loadout_scroll" && gearScrolls
    ? gearScrolls.snapshot.scrolls.find((entry) => entry.position === scrollPosition) ?? gearScrolls.snapshot.scrolls[0] ?? null
    : null;
  const [quantity, setQuantity] = useState(1);
  const transferMaximum = Math.min(item.quantity, Math.max(0, transferAction?.maximumQuantity ?? item.quantity));
  const splitMaximum = Math.min(item.quantity - 1, item.maxStack);
  const maximum = mode === "split" ? splitMaximum : transferMaximum;
  const addressable = online && item.stackId.length > 0;
  const setValidQuantity = (value: number): void => setQuantity(Math.max(1, Math.min(Math.floor(Number.isFinite(value) ? value : 1), maximum)));
  useEffect(() => {
    if (maximum < 1) setMode((current) => current === "details" ? current : "actions");
    setQuantity((current) => Math.max(1, Math.min(current, maximum)));
  }, [maximum]);
  const actions: GamePromptAction[] = mode === "details" ? [] : mode === "actions" ? [
    ...(item.provenance ? [{ key: "details", label: "Details", enabled: true, onSelect: () => setMode("details") }] : []),
    ...(showInventoryActions && scroll && gearScrolls ? [
      { key: "remember-gear", label: "Remember Weapons and Armor", enabled: online, onSelect: () => { gearScrolls.onRemember(scroll.position, "weapons_armor"); } },
      { key: "remember-jewelry", label: "Remember Jewelry", enabled: online, onSelect: () => { gearScrolls.onRemember(scroll.position, "jewelry"); } },
      ...(scroll.items.some((entry) => entry.carried)
        ? [{ key: "equip-scroll", label: "Equip Remembered Items", tone: "primary" as const, enabled: online, onSelect: () => { if (gearScrolls.onEquip(scroll.position)) onClose(); } }]
        : [])
    ] : []),
    ...(item.itemId === "fishing_rod" ? [{ key: "fish", label: "Fish", enabled: addressable && item.canUse, onSelect: () => { if (onFish?.()) onClose(); } }] : []),
    ...(showInventoryActions && (item.itemId === "manor_skin" || item.itemId === "face_mask") && (skinEquipped ? onUnequipSkin : onEquipSkin)
      ? [skinEquipped
          ? { key: "unequip-skin", label: item.itemId === "face_mask" ? "Take off" : "Unequip", enabled: online, onSelect: () => { if (onUnequipSkin?.()) onClose(); } }
          : { key: "equip-skin", label: item.itemId === "face_mask" ? "Wear" : "Equip on Manor", tone: "primary" as const, enabled: online, onSelect: () => { if (onEquipSkin?.()) onClose(); } }]
      : []),
    ...(showInventoryActions && item.itemId !== "fishing_rod" && item.itemId !== "giving_tree_sapling" && item.itemId !== "manor_skin" && item.itemId !== "face_mask" && item.itemId !== "loadout_scroll" ? [{ key: "use", label: "Use", enabled: addressable && item.canUse, onSelect: () => { if (onUse?.()) onClose(); } }] : []),
    ...(showInventoryActions && onPlant && (item.itemId === "giving_berry" || item.itemId === "giving_tree_sapling")
      ? [{ key: "plant", label: "Plant", enabled: addressable, onSelect: () => { if (onPlant()) onClose(); } }] : []),
    ...(showInventoryActions ? [{ key: "drop", label: manorMode ? "Store" : "Drop", enabled: addressable && item.canDrop && !dropDisabledReason, onSelect: () => onDrop?.() }] : []),
    ...(transferAction ? [
      { key: "transfer", label: transferAction.label, enabled: addressable && transferMaximum > 0 && !transferAction.disabledReason,
        onSelect: () => { setQuantity(1); setMode("transfer"); } },
      { key: "transfer-all", label: transferAction.allLabel, enabled: addressable && transferMaximum > 0 && !transferAction.disabledReason,
        onSelect: () => { if (transferAction.onQuantity(transferMaximum)) onClose(); } }
    ] : []),
    ...(showStackActions ? [{ key: "split", label: "Split", enabled: addressable && splitMaximum > 0,
      onSelect: () => { setQuantity(1); setMode("split"); } }] : []),
    ...(showStackActions && item.manualSplit ? [{ key: "restack", label: "Restack", enabled: addressable, onSelect: () => { if (onRestack?.()) onClose(); } }] : [])
  ] : [{ key: "confirm", label: `${mode === "split" ? "Split" : transferAction?.label ?? "Transfer"} ${quantity.toLocaleString()}`,
    enabled: addressable && maximum > 0,
    onSelect: () => { if (mode === "split" ? onSplit?.(quantity) : transferAction?.onQuantity(quantity)) onClose(); }
  }];
  const quantityLabel = mode === "split" ? "Split" : transferAction?.label ?? "Transfer";
  return <GameActionPrompt title={item.name} category={surfaceLabel} ariaLabel={`${item.name} actions`} elevated
    artwork={<ItemArtwork itemId={item.itemId} variant={item.look ?? item.variant} label={item.name} />}
    detail={`${skinEquipped ? "Equipped · " : ""}×${item.quantity.toLocaleString()} · ${formatWeightKg(item.totalWeightGrams)} kg`}
    content={<>
      <ItemRarityLabel rarity={item.rarity} />
      {mode === "details" && item.provenance ? <ShopProvenanceDetails provenance={item.provenance} /> : null}
      {mode === "actions" && item.description ? <p className="kingdom-note">{item.description}</p> : null}
      {mode === "actions" && scroll && gearScrolls ? <div className="gear-scroll-detail">
        {gearScrolls.snapshot.scrolls.length > 1 ? <div className="gear-scroll-picker" role="radiogroup" aria-label="Scroll">
          {gearScrolls.snapshot.scrolls.map((entry) => <button key={entry.position} type="button" role="radio"
            aria-checked={entry.position === scroll.position} className="game-app-button"
            onClick={() => setScrollPosition(entry.position)}>{entry.position}</button>)}
        </div> : null}
        <ul className="gear-scroll-items" aria-label={`Scroll ${scroll.position} remembers`}>
          {scroll.items.map((entry) => <li key={entry.slot} className={entry.carried ? undefined : "is-missing"}>
            {entry.displayName ?? "Not carried"}
          </li>)}
        </ul>
      </div> : null}
      {mode === "actions" && skinEquipped
        ? <p className="kingdom-note">{item.itemId === "face_mask" ? "Worn right now. Take it off before you drop, trade, gift, sell or store it." : "Equipped on your Manor. Unequip it before you drop, trade, gift, sell or store it."}</p>
        : null}
      {mode === "transfer" || mode === "split" ? <label className="drop-amount-control">
        <span className="drop-amount-label"><span>Quantity</span><strong>{quantity.toLocaleString()}</strong></span>
        <input className="drop-amount-slider" type="range" min={1} max={maximum} step={1} value={quantity}
          aria-label={`${quantityLabel} quantity slider`} onChange={(event) => setValidQuantity(Number(event.currentTarget.value))} />
        <div className="drop-amount-stepper">
          <button type="button" aria-label="Decrease quantity" disabled={quantity <= 1} onClick={() => setValidQuantity(quantity - 1)}>−</button>
          <input type="number" inputMode="numeric" min={1} max={maximum} step={1} value={quantity} aria-label={`${quantityLabel} quantity`}
            onChange={(event) => setValidQuantity(Number(event.currentTarget.value))} />
          <button type="button" aria-label="Increase quantity" disabled={quantity >= maximum} onClick={() => setValidQuantity(quantity + 1)}>+</button>
        </div>
      </label> : null}
    </>}
    actions={actions} cancelLabel={mode === "actions" ? "Cancel" : "Back"} onCancel={mode === "actions" ? onClose : startInDetails && mode === "details" ? onClose : () => setMode("actions")} />;
}
