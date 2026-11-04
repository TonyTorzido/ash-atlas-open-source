import type { EquipmentSnapshotV2 } from "./equipment.js";
import type { PlayerInventoryItem, PlayerInventorySnapshot } from "./collectibles.js";
import type {
  InventoryProtectionSnapshot,
  InventoryStackProtection,
  MaterialKeepPolicy,
  UniqueItemProtection
} from "./inventoryProtection.js";

const DEFAULT_VARIANT = "default";

export type MaterialProtectionProjection = {
  materialPolicies: MaterialKeepPolicy[];
  stackAllocations: InventoryStackProtection[];
};

export function projectMaterialProtection(
  inventory: PlayerInventorySnapshot,
  policies: readonly MaterialKeepPolicy[]
): MaterialProtectionProjection {
  const totals = new Map<string, bigint>();
  for (const item of inventory.items) {
    const key = identityKey(item.resourceType, item.variant);
    totals.set(
      key,
      (totals.get(key) ?? 0n) + safeQuantity(item.quantity, "inventory quantity")
    );
  }

  const materialPolicies = policies
    .map((policy) => ({
      itemId: policy.itemId,
      variant: protocolVariant(policy.variant),
      keepQuantity: safeNumber(
        safeQuantity(policy.keepQuantity, "material keep quantity"),
        "material keep quantity"
      ),
      currentTotal: safeNumber(
        totals.get(identityKey(policy.itemId, policy.variant)) ?? 0n,
        "material current total"
      )
    }))
    .sort(comparePolicies);
  const keepByIdentity = new Map(
    materialPolicies.map((policy) => [
      identityKey(policy.itemId, policy.variant),
      BigInt(policy.keepQuantity)
    ])
  );
  const remainingKeep = new Map(keepByIdentity);
  const stackAllocations = [...inventory.items]
    .sort(compareInventoryStacks)
    .map((item): InventoryStackProtection => {
      const key = identityKey(item.resourceType, item.variant);
      const quantity = safeQuantity(item.quantity, "inventory quantity");
      const protectedQuantity = minBigInt(remainingKeep.get(key) ?? 0n, quantity);
      remainingKeep.set(key, (remainingKeep.get(key) ?? 0n) - protectedQuantity);
      const movableQuantity = quantity - protectedQuantity;
      const keepQuantity = keepByIdentity.get(key) ?? 0n;
      return {
        stackId: item.stackId ?? "",
        itemId: item.resourceType,
        variant: protocolVariant(item.variant),
        protectedQuantity: safeNumber(protectedQuantity, "protected quantity"),
        movableQuantity: safeNumber(movableQuantity, "movable quantity"),
        status: protectedQuantity === 0n
          ? "none"
          : movableQuantity === 0n
            ? "protected"
            : "partial",
        reason: protectedQuantity === 0n
          ? null
          : `Keep ${formatQuantity(keepQuantity)} in Inventory`
      };
    });

  return { materialPolicies, stackAllocations };
}

export function projectEffectiveInventoryProtection(
  policySnapshot: InventoryProtectionSnapshot,
  inventory: PlayerInventorySnapshot,
  equipment?: EquipmentSnapshotV2 | null
): InventoryProtectionSnapshot {
  const material = projectMaterialProtection(
    inventory,
    policySnapshot.materialPolicies
  );
  return {
    playerId: policySnapshot.playerId,
    revision: policySnapshot.revision,
    ...material,
    uniqueItems: equipment
      ? projectUniqueItemProtection(policySnapshot.uniqueItems, equipment)
      : policySnapshot.uniqueItems
  };
}

function projectUniqueItemProtection(
  policies: readonly UniqueItemProtection[],
  equipment: EquipmentSnapshotV2
): UniqueItemProtection[] {
  const protectedById = new Map(
    policies.map((policy) => [
      policy.equipmentInstanceId,
      policy.protected
    ])
  );
  return equipment.instances
    .filter((item) => item.location !== "destroyed")
    .sort((left, right) =>
      (left.inventorySlotIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.inventorySlotIndex ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.instanceId, right.instanceId)
    )
    .map((item) => ({
      equipmentInstanceId: item.instanceId,
      protected: protectedById.get(item.instanceId) ?? false,
      systemReason: item.location === "equipped"
        ? "Equipped — cannot be stored"
        : item.location === "manor_storage"
          ? "Already stored in Manor Storage"
          : item.savedKitIndices.length > 0
            ? "Referenced by a saved combat kit"
            : item.manorStorable === false
              ? "This item cannot be stored"
              : null
    }));
}

function comparePolicies(left: MaterialKeepPolicy, right: MaterialKeepPolicy): number {
  return compareText(left.itemId, right.itemId) ||
    compareText(normalizedVariant(left.variant), normalizedVariant(right.variant));
}

function compareInventoryStacks(
  left: PlayerInventoryItem,
  right: PlayerInventoryItem
): number {
  return compareText(left.resourceType, right.resourceType) ||
    compareText(normalizedVariant(left.variant), normalizedVariant(right.variant)) ||
    (left.slotIndex ?? Number.MAX_SAFE_INTEGER) -
      (right.slotIndex ?? Number.MAX_SAFE_INTEGER) ||
    compareText(left.stackId ?? "", right.stackId ?? "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identityKey(itemId: string, variant: string | null): string {
  return `${itemId}\0${normalizedVariant(variant)}`;
}

function normalizedVariant(variant: string | null): string {
  return variant ?? DEFAULT_VARIANT;
}

function protocolVariant(variant: string | null): string | null {
  return normalizedVariant(variant) === DEFAULT_VARIANT
    ? null
    : normalizedVariant(variant);
}

function safeQuantity(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
  return BigInt(value);
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return number;
}

function formatQuantity(value: bigint): string {
  return safeNumber(value, "material keep quantity").toLocaleString("en-US");
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
