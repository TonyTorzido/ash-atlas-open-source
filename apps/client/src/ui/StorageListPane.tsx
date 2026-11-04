import {
  getItemWeightGrams,
  getBackpackWeightGrams,
  formatWeightKg,
  requireBackpackLevel,
  type BackpackInstanceSnapshot,
  type EquipmentInstanceV2,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";

import type { InventoryPanelRow } from "../inventory/inventoryPanelModel.js";
import { InventoryCarrySummary, InventoryEntryRow, StorageWeightSummary } from "./InventoryCarryList.js";
import { ItemArtwork } from "./ItemArtwork.js";

export function StorageListPane({
  pane,
  carryInventory,
  title,
  rows,
  equipmentItems,
  backpackItems = [],
  online,
  pending,
  selectedStackId,
  loading = false,
  onSelectStack,
  onSelectEquipment,
  onSelectBackpack = () => {},
  stackProtectionStatus,
  equipmentProtected,
  onReorganize,
  currentWeightGrams,
  maximumWeightGrams,
  canReorganize = true
}: {
  pane: "inventory" | "storage";
  carryInventory?: PlayerInventorySnapshot;
  title: string;
  rows: InventoryPanelRow[];
  equipmentItems: EquipmentInstanceV2[];
  backpackItems?: BackpackInstanceSnapshot[];
  online: boolean;
  pending: boolean;
  selectedStackId: string | null;
  loading?: boolean;
  onSelectStack(stackId: string): void;
  onSelectEquipment(item: EquipmentInstanceV2): void;
  onSelectBackpack?(item: BackpackInstanceSnapshot): void;
  stackProtectionStatus(stackId: string): "none" | "partial" | "protected" | "system";
  equipmentProtected(instanceId: string): boolean;
  onReorganize(): boolean;
  currentWeightGrams?: string | undefined;
  maximumWeightGrams?: string | undefined;
  canReorganize?: boolean;
}): React.JSX.Element {
  const isStorage = pane === "storage";
  if (!isStorage) return <section className="manor-transfer-pane inventory-transfer-player-list"
    aria-label={title} data-inventory-transfer-pane="inventory">
    <header><h3>{title}</h3>{carryInventory ? <InventoryCarrySummary inventory={carryInventory} /> : null}</header>
    <ul className="inventory-carry-list" aria-label={`${title} items`}>
      {rows.map((item) => <InventoryEntryRow key={item.key} name={item.name} quantity={item.quantity} weightGrams={item.totalWeightGrams}
        artwork={<ItemArtwork itemId={item.itemId} variant={item.variant} label={item.name} />}
        protectedItem={stackProtectionStatus(item.stackId) !== "none"} selected={selectedStackId === item.stackId}
        onSelect={() => onSelectStack(item.stackId)} />)}
      {equipmentItems.map((item) => <InventoryEntryRow key={item.instanceId} name={item.displayName} quantity={1}
        weightGrams={getItemWeightGrams(item.definitionId)} detail={`Level ${item.itemLevel}${item.location === "equipped" ? " · Equipped" : ""}`}
        artwork={<ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />}
        protectedItem={equipmentProtected(item.instanceId)} onSelect={() => onSelectEquipment(item)} />)}
      {backpackItems.map((item) => <InventoryEntryRow key={item.instanceId} name={`Backpack +${item.upgradeLevel ?? 0}`} quantity={1}
        weightGrams={item.unitWeightGrams ?? getBackpackWeightGrams()} detail={`+${formatWeightKg(item.capacityBonusGrams ?? requireBackpackLevel(item.upgradeLevel ?? 0).capacityBonusGrams)} kg capacity`}
        artwork={<ItemArtwork itemId="pack" label="Backpack" />} onSelect={() => onSelectBackpack(item)} />)}
    </ul>
    {rows.length + equipmentItems.length + backpackItems.length === 0 ? <p className="empty-state">Inventory is empty.</p> : null}
  </section>;

  return (
    <section
      className="manor-transfer-pane"
      aria-label={title}
      data-inventory-transfer-pane={pane}
    >
      <header>
        <div>
          <h3>{title}</h3>
          <span>{rows.length + equipmentItems.length + backpackItems.length} items</span>
        </div>
        <StorageWeightSummary currentWeightGrams={currentWeightGrams}
          maximumWeightGrams={maximumWeightGrams} available={!loading} />
        <button
          type="button"
          disabled={
            !canReorganize ||
            !online ||
            pending ||
            rows.length + equipmentItems.length + backpackItems.length === 0
          }
          title={!canReorganize
            ? "Only the Mayor may reorganize City Warehouse stacks."
            : "Combine compatible automatic stacks, then arrange the remaining items."}
          onClick={onReorganize}
        >
          Reorganize
        </button>
      </header>
      <div className="inventory-list-shell">
        {loading ? <p className="inventory-status">Loading authoritative storage…</p> : (
          <ul className="inventory-carry-list" aria-label={`${title} items`}>
            {rows.map((item) => <InventoryEntryRow key={item.key} name={item.name} quantity={item.quantity}
              weightGrams={item.totalWeightGrams}
              detail={item.manualSplit ? "Manually split" : undefined}
              artwork={<ItemArtwork itemId={item.itemId} variant={item.variant} label={item.name} />}
              selected={selectedStackId === item.stackId}
              protectedItem={stackProtectionStatus(item.stackId) !== "none"}
              onSelect={() => onSelectStack(item.stackId)} />)}
            {equipmentItems.map((item) => <InventoryEntryRow key={item.instanceId} name={item.displayName} quantity={1}
              weightGrams={getItemWeightGrams(item.definitionId)} detail={`Level ${item.itemLevel}`}
              artwork={<ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />}
              protectedItem={equipmentProtected(item.instanceId)} onSelect={() => onSelectEquipment(item)} />)}
            {backpackItems.map((item) => <InventoryEntryRow key={item.instanceId}
              name={`Backpack +${item.upgradeLevel ?? 0}`} quantity={1}
              weightGrams={item.unitWeightGrams ?? getBackpackWeightGrams()}
              detail={`+${formatWeightKg(item.capacityBonusGrams ?? requireBackpackLevel(item.upgradeLevel ?? 0).capacityBonusGrams)} kg capacity`}
              artwork={<ItemArtwork itemId="pack" label="Backpack" />}
              onSelect={() => onSelectBackpack(item)} />)}
          </ul>
        )}
      </div>
      {!loading && rows.length + equipmentItems.length + backpackItems.length === 0
        ? <p className="empty-state">Storage is empty.</p> : null}
    </section>
  );
}
