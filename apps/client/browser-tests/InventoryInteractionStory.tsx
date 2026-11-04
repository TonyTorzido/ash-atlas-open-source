import { emptyEquipmentSlots, emptyInventoryTotals, getItemWeightGrams, INVENTORY_CATALOG, requireEquipmentDefinition,
  resolveEquipmentCombatStats, resolveEquipmentItemDerivedStats, type EquipmentInstanceV2, type EquipmentSnapshotV2 } from "@ash-atlas/shared";
import { useState } from "react";
import { normalizeInventorySnapshot, resolveInventoryDropSelection, type InventoryDropSelection } from "../src/inventory/inventoryPanelModel.js";
import { InventoryPanel } from "../src/ui/InventoryPanel.js";
import { DropItemDialog } from "../src/ui/DropItemDialog.js";

declare global { interface Window { inventoryTestDrops: number[]; } }

export function InventoryInteractionStory({ layout = "desktop" }: { layout?: "desktop" | "phone" }): React.JSX.Element {
  const [inventory, setInventory] = useState(() => normalizeInventorySnapshot({
    playerId: "player-1", revision: 1, currentWeightGrams: String(Object.values(INVENTORY_CATALOG).filter((item) => item.kind !== "equipment").slice(0, 48).reduce((total, item, index) => total + getItemWeightGrams(item.itemId) * (item.itemId === "wood" ? 437 : (index % 3) + 1), 2 * getItemWeightGrams("starter_sword"))), maximumWeightGrams: "150000",
    items: Object.values(INVENTORY_CATALOG).filter((item) => item.kind !== "equipment").slice(0, 48).map((item, index) => ({
      resourceType: item.itemId, quantity: item.itemId === "wood" ? 437 : (index % 3) + 1,
      variant: null, entryId: `entry-${item.itemId}`, stackId: `entry-${item.itemId}`
    })), totals: { ...emptyInventoryTotals(), wood: 437 }
  }, "player-1"));
  const [selection, setSelection] = useState<InventoryDropSelection | null>(null);
  const [amount, setAmount] = useState(1);
  const protection = { playerId: "player-1", revision: 1, materialPolicies: [], uniqueItems: [],
    stackAllocations: inventory.items.map((item) => ({ stackId: item.stackId!, itemId: item.resourceType,
      variant: item.variant, protectedQuantity: 0, movableQuantity: item.quantity, status: "none" as const, reason: null })) };
  const resolved = selection ? resolveInventoryDropSelection(selection, inventory, protection) : null;
  return <>
    <InventoryPanel open inventory={inventory} equipment={equipment()} protection={protection} hasSnapshot connectionStatus="online"
      layout={layout} droppingItemKey={null} goldBalance="12480" onOpenLoadout={() => {}} onOpenStats={() => {}} onOpenKits={() => {}}
      onOpenBackpacks={() => {}} onOpenProtection={() => {}}
      onChooseDrop={(item) => { setSelection(item); setAmount(1); }} onClose={() => {}} />
    {resolved ? <DropItemDialog selection={resolved} amount={amount} busy={false} onAmountChange={setAmount}
      onCancel={() => setSelection(null)} onConfirm={() => {
        window.inventoryTestDrops ??= [];
        window.inventoryTestDrops.push(amount);
        setInventory((current) => ({ ...current, revision: current.revision + 1,
          currentWeightGrams: String(BigInt(current.currentWeightGrams!) - BigInt(amount) * BigInt(getItemWeightGrams(resolved.itemId))),
          items: current.items.map((item) => item.stackId === resolved.stackId ? { ...item, quantity: item.quantity - amount, totalWeightGrams: String(BigInt(item.quantity - amount) * BigInt(item.unitWeightGrams ?? 0)) } : item).filter((item) => item.quantity > 0) }));
        setSelection(null);
      }} /> : null}
  </>;
}

function equipment(): EquipmentSnapshotV2 {
  const starter = equipmentItem(0, "00000000-0000-4000-8000-000000000001");
  const maximum = equipmentItem(25, "00000000-0000-4000-8000-000000000002");
  const active = { ...emptyEquipmentSlots<EquipmentInstanceV2 | null>(null), melee: starter };
  const derivedStats = resolveEquipmentCombatStats({
    context: "pvp_open_world",
    characterLevel: 25,
    classId: "warrior",
    classRank: 0,
    loadout: {
      active: {
        ...emptyEquipmentSlots(null),
        melee: {
          instanceId: starter.instanceId,
          itemLevel: starter.itemLevel,
          definition: requireEquipmentDefinition(starter.definitionId)
        }
      },
      readiedWeaponSlot: "melee"
    }
  });
  return {
    snapshotVersion: 2,
    balanceVersion: 2,
    playerId: "player-1",
    characterLevel: 25,
    repairMessage: null,
    instances: [starter, maximum],
    active,
    readiedWeaponSlot: "melee",
    activeKitIndex: null,
    kits: [],
    inventoryRevision: 2,
    activeRevision: 1,
    checkpointRevision: 1,
    derivedStats,
    weapon: starter,
    chest: null,
    totalAttackPowerBonus: 2,
    totalDefenseBonus: 0
  };
}

function equipmentItem(level: number, instanceId: string): EquipmentInstanceV2 {
  const definition = requireEquipmentDefinition("starter_sword");
  const derived = resolveEquipmentItemDerivedStats({
    item: { instanceId, definition, itemLevel: level },
    slot: "melee",
    classId: "warrior"
  });
  return {
    instanceId,
    definitionId: "starter_sword",
    displayName: level === 25 ? "Masterwork Sword" : "Starter Sword",
    ownerPlayerId: "player-1",
    location: level === 0 ? "equipped" : "inventory",
    inventorySlotIndex: level === 25 ? 2 : 3,
    equippedSlot: level === 0 ? "melee" : null,
    itemLevel: level,
    maximumItemLevel: 25,
    category: "melee_weapon",
    balanceVersion: 2,
    enchantmentIdentity: null,
    attackPowerBonus: Math.round(derived.universalAttackContribution),
    defenseBonus: Math.round(derived.universalDefenseContribution),
    weaponCategory: "sword",
    armorCategory: null,
    twoHanded: false,
    savedKitIndices: level === 0 ? [1] : [],
    derived,
    nextUpgradeCost: level === 25 ? null : "10",
    nextUpgradeLevel: level === 25 ? null : level + 1,
    upgradeDisabledReason: level === 25 ? "maximum_level" : null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}
