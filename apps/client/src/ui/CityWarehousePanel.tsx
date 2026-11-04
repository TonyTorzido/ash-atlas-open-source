import {
  getItemWeightGrams,
  INVENTORY_CATALOG,
  type CityWarehouseSnapshot,
  type InventoryProtectionSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { resourceDisplayName } from "../collectibles/harvest.js";
import {
  inventoryPanelRows,
  type InventoryPanelRow
} from "../inventory/inventoryPanelModel.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DestinationShell } from "./DestinationShell.js";
import { InventoryItemActionDialog } from "./InventoryItemActionDialog.js";
import { StorageListPane } from "./StorageListPane.js";

type Props = {
  open: boolean;
  warehouse: CityWarehouseSnapshot | null;
  activeWarehouseStructureId: string | null;
  inventory: PlayerInventorySnapshot;
  protection: InventoryProtectionSnapshot | null;
  online: boolean;
  pending: boolean;
  feedback: string | null;
  error: string | null;
  walletGold: string | null;
  layout: "desktop" | "phone";
  onDonate(donation: CityWarehouseDonationIntent): boolean;
  onDonateAll(): boolean;
  onDonateGold(amount: string): boolean;
  onMove(stackId: string, targetSlot: number): boolean;
  onReorganizeWarehouse?(): boolean;
  onClose(): void;
};

export type CityWarehouseDonationIntent = Readonly<{
  warehouseStructureId: string;
  stackId: string;
  itemId: string;
  displayName: string;
  variant: string | null;
  quantity: number;
}>;

export function CityWarehousePanel({
  open,
  warehouse,
  activeWarehouseStructureId,
  inventory,
  protection,
  online,
  pending,
  feedback,
  error,
  walletGold,
  layout,
  onDonate,
  onDonateAll,
  onDonateGold,
  onReorganizeWarehouse = () => false,
  onClose
}: Props): React.JSX.Element | null {
  const [phonePane, setPhonePane] = useState<"inventory" | "storage">("inventory");
  const [selectedStackId, setSelectedStackId] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [goldDialogOpen, setGoldDialogOpen] = useState(false);
  const [pendingDonation, setPendingDonation] =
    useState<CityWarehouseDonationIntent | null>(null);
  const donationSubmissionRef = useRef(false);
  const playerRows = useMemo(() => inventoryPanelRows(inventory), [inventory]);
  const warehouseRows = useMemo(() => warehouse?.stacks.map((stack): InventoryPanelRow => ({
    key: stack.stackId,
    stackId: stack.stackId,
    slotIndex: stack.slotIndex,
    itemId: stack.itemId,
    variant: stack.variant,
    name: warehouseMaterialName(stack.itemId, stack.variant),
    rarity: INVENTORY_CATALOG[stack.itemId]?.rarity ?? "common",
    quantity: stack.quantity,
    unitWeightGrams: getItemWeightGrams(stack.itemId),
    totalWeightGrams: String(BigInt(stack.quantity) * BigInt(getItemWeightGrams(stack.itemId))),
    maxStack: stack.maxStack ?? INVENTORY_CATALOG[stack.itemId]?.maxStack ?? 1,
    canDrop: false,
    canUse: false,
    manualSplit: false
  })) ?? [], [warehouse]);
  const selected = playerRows.find((row) => row.stackId === selectedStackId) ?? null;
  const selectedProtection = protection?.stackAllocations.find(
    (allocation) => allocation.stackId === selectedStackId
  ) ?? null;
  const stageDonation = (stackId: string, quantity: number): boolean => {
    const row = playerRows.find((candidate) => candidate.stackId === stackId);
    if (!activeWarehouseStructureId || !row) return false;
    donationSubmissionRef.current = false;
    setPendingDonation({
      warehouseStructureId: activeWarehouseStructureId,
      stackId: row.stackId,
      itemId: row.itemId,
      displayName: row.name,
      variant: row.variant,
      quantity
    });
    return true;
  };

  useEffect(() => {
    if (open) return;
    setSelectedStackId(null);
    setConfirmBulk(false);
    setGoldDialogOpen(false);
    setPendingDonation(null);
    donationSubmissionRef.current = false;
  }, [open]);
  if (!open) return null;

  return (
    <>
      <DestinationShell
        open
        title="City Warehouse"
        eyebrow={warehouse?.cityName ?? "City storage"}
        subtitle="Donations become permanent city property."
        closeLabel="Close City Warehouse"
        className={`manor-storage-panel manor-transfer-workspace city-warehouse-panel ${layout}`}
        layout={layout}
        phoneBackLabel="Back"
        phoneShowReturnToGame={false}
        closeDisabled={false}
        onClose={onClose}
      >
        <header className="manor-transfer-header">
          <div className="manor-transfer-bulk-actions">
            <button
              type="button"
              disabled={!online || pending || !protection || playerRows.length === 0}
              onClick={() => setConfirmBulk(true)}
            >
              Donate All Eligible
            </button>
            <button
              type="button"
              disabled={
                !online ||
                pending ||
                !warehouse?.gold.canDonate ||
                parseGold(warehouse?.gold.remainingCapacity ?? "0") <= 0n
              }
              onClick={() => setGoldDialogOpen(true)}
            >
              Donate Gold
            </button>
            <strong>Tier {warehouse?.tier ?? "—"}</strong>
            <strong>
              City Gold {warehouse?.gold.balance ?? "0"} /{" "}
              {warehouse?.gold.capacity ?? "0"}
            </strong>
          </div>
        </header>
        {error ? (
          <p className="city-warehouse-feedback error" role="alert">
            {error}
          </p>
        ) : feedback ? (
          <p className="city-warehouse-feedback" role="status" aria-live="polite">
            {feedback}
          </p>
        ) : activeWarehouseStructureId && !warehouse ? (
          <p className="city-warehouse-feedback" role="status" aria-live="polite">
            Loading authoritative City Warehouse contents...
          </p>
        ) : null}
        {warehouse && warehouse.stacks.length === 0 ? (
          <p className="city-warehouse-empty">
            This City Warehouse is empty. Donate eligible materials from your Inventory.
          </p>
        ) : null}
        {layout === "phone" ? (
          <nav className="manor-transfer-tabs" aria-label="Warehouse panes">
            <button
              type="button"
              className={phonePane === "inventory" ? "active" : ""}
              aria-pressed={phonePane === "inventory"}
              onClick={() => setPhonePane("inventory")}
            >
              Inventory
            </button>
            <button
              type="button"
              className={phonePane === "storage" ? "active" : ""}
              aria-pressed={phonePane === "storage"}
              onClick={() => setPhonePane("storage")}
            >
              City Warehouse
            </button>
          </nav>
        ) : null}
        <div className="manor-transfer-panes">
          {layout === "desktop" || phonePane === "inventory" ? (
            <StorageListPane
              pane="inventory"
              title="Player Inventory"
              rows={playerRows}
              equipmentItems={[]}
              carryInventory={inventory}
              online={online}
              pending={pending}
              selectedStackId={selectedStackId}
              onSelectStack={setSelectedStackId}
              onSelectEquipment={() => {}}
              stackProtectionStatus={(stackId) =>
                protection?.stackAllocations.find(
                  (entry) => entry.stackId === stackId
                )?.status ?? "none"}
              equipmentProtected={() => false}
              onReorganize={() => false}
            />
          ) : null}
          {layout === "desktop" || phonePane === "storage" ? (
            <StorageListPane
              pane="storage"
              title="City Warehouse"
              rows={warehouseRows}
              equipmentItems={[]}
              currentWeightGrams={warehouse?.currentWeightGrams}
              maximumWeightGrams={warehouse?.maximumWeightGrams}
              online={online}
              pending={pending}
              selectedStackId={null}
              loading={Boolean(activeWarehouseStructureId && !warehouse && !error)}
              onSelectStack={() => {}}
              onSelectEquipment={() => {}}
              stackProtectionStatus={() => "none"}
              equipmentProtected={() => false}
              onReorganize={onReorganizeWarehouse}
              canReorganize={warehouse?.canReorganize ?? false}
            />
          ) : null}
        </div>
      </DestinationShell>
      {selected ? (
        <InventoryItemActionDialog
          item={selected}
          online={online && !pending}
          manorMode={false}
          surfaceLabel="Player Inventory item"
          showInventoryActions={false}
          transferAction={{
            label: "Donate",
            allLabel: "Donate All",
            maximumQuantity: selectedProtection?.movableQuantity ?? 0,
            disabledReason: !protection
              ? "Loading authoritative item protection…"
              : selectedProtection?.movableQuantity === 0
                ? selectedProtection.reason
                : null,
            onQuantity: (quantity) => {
              return stageDonation(selected.stackId, quantity);
            }
          }}
          onSplit={() => false}
          onRestack={() => false}
          onClose={() => setSelectedStackId(null)}
        />
      ) : null}
      {pendingDonation ? (
        <ConfirmDialog
          title={`Donate ${pendingDonation.quantity.toLocaleString()} ${pendingDonation.displayName}?`}
          message={`Donate exactly ${pendingDonation.quantity.toLocaleString()} ${pendingDonation.displayName}. Donated materials become permanent city property and cannot be withdrawn.`}
          confirmLabel={`Donate ${pendingDonation.quantity.toLocaleString()}`}
          busy={pending}
          tone="primary"
          onCancel={() => {
            donationSubmissionRef.current = false;
            setPendingDonation(null);
          }}
          onConfirm={() => {
            if (pending || donationSubmissionRef.current) return;
            donationSubmissionRef.current = true;
            if (onDonate(pendingDonation)) {
              setPendingDonation(null);
            } else {
              donationSubmissionRef.current = false;
            }
          }}
        />
      ) : null}
      {confirmBulk ? (
        <ConfirmDialog
          title="Donate all eligible materials?"
          message="Protected quantities remain in your Inventory. Every donated material becomes permanent city property and cannot be withdrawn."
          confirmLabel="Donate All Eligible"
          busy={pending}
          tone="primary"
          onCancel={() => setConfirmBulk(false)}
          onConfirm={() => {
            if (onDonateAll()) setConfirmBulk(false);
          }}
        />
      ) : null}
      {goldDialogOpen && warehouse ? (
        <GoldDonationDialog
          walletGold={walletGold ?? "0"}
          cityGold={warehouse.gold.balance}
          capacity={warehouse.gold.capacity}
          remainingCapacity={warehouse.gold.remainingCapacity}
          pending={pending}
          onCancel={() => setGoldDialogOpen(false)}
          onDonate={(amount) => {
            if (!onDonateGold(amount)) return false;
            setGoldDialogOpen(false);
            return true;
          }}
        />
      ) : null}
    </>
  );
}

function warehouseMaterialName(
  itemId: CityWarehouseSnapshot["stacks"][number]["itemId"],
  variant: string | null
): string {
  const base = resourceDisplayName(itemId);
  if (!variant || variant === "default") return base;
  const label = variant
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
  return `${label} ${base}`;
}

function GoldDonationDialog({
  walletGold,
  cityGold,
  capacity,
  remainingCapacity,
  pending,
  onCancel,
  onDonate
}: {
  walletGold: string;
  cityGold: string;
  capacity: string;
  remainingCapacity: string;
  pending: boolean;
  onCancel(): void;
  onDonate(amount: string): boolean;
}): React.JSX.Element {
  const maximum = minBigInt(parseGold(walletGold), parseGold(remainingCapacity));
  const [amount, setAmount] = useState("");
  const submitting = useRef(false);
  const validation = validateGoldDonation(
    amount,
    parseGold(walletGold),
    parseGold(remainingCapacity)
  );
  return (
    <div className="modal-scrim city-gold-dialog-scrim" role="presentation">
      <section
        className="confirm-dialog city-gold-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="city-gold-dialog-title"
      >
        <h2 id="city-gold-dialog-title">Donate Gold</h2>
        <dl>
          <div><dt>Wallet Gold</dt><dd>{walletGold}</dd></div>
          <div><dt>Current City Gold</dt><dd>{cityGold}</dd></div>
          <div><dt>Capacity</dt><dd>{capacity}</dd></div>
          <div><dt>Remaining capacity</dt><dd>{remainingCapacity}</dd></div>
        </dl>
        <label>
          <span>Whole Gold amount</span>
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={amount}
            onChange={(event) => {
              submitting.current = false;
              setAmount(event.currentTarget.value);
            }}
          />
        </label>
        <button
          type="button"
          disabled={maximum <= 0n}
          onClick={() => setAmount(maximum.toString())}
        >
          Max
        </button>
        <p>Gold donations are permanent city property and cannot be withdrawn.</p>
        {validation ? <p className="error" role="alert">{validation}</p> : null}
        <footer>
          <button type="button" disabled={pending} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={pending || Boolean(validation)}
            onClick={() => {
              if (pending || validation || submitting.current) return;
              submitting.current = true;
              if (!onDonate(amount.trim())) submitting.current = false;
            }}
          >
            Donate
          </button>
        </footer>
      </section>
    </div>
  );
}

function validateGoldDonation(
  raw: string,
  wallet: bigint,
  remainingCapacity: bigint
): string | null {
  if (!raw.trim()) return "Enter an amount.";
  if (!/^[0-9]+$/u.test(raw.trim())) return "Enter a positive whole number.";
  const amount = BigInt(raw.trim());
  if (amount <= 0n) return "Amount must be greater than zero.";
  if (amount > wallet) return "Amount exceeds your wallet Gold.";
  if (amount > remainingCapacity) {
    return "Amount exceeds the remaining City Gold capacity.";
  }
  return null;
}

function parseGold(value: string): bigint {
  return /^[0-9]+$/u.test(value) ? BigInt(value) : 0n;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
