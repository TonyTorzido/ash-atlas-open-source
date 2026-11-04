import type { InventoryProtectionSnapshot } from "@ash-atlas/shared";

export type InventoryProtectionInstallResult = {
  accepted: boolean;
  snapshot: InventoryProtectionSnapshot | null;
};

export function acceptInventoryProtectionSnapshot(
  current: InventoryProtectionSnapshot | null,
  incoming: InventoryProtectionSnapshot,
  playerId: string
): InventoryProtectionInstallResult {
  if (incoming.playerId !== playerId) {
    return { accepted: false, snapshot: current };
  }
  const compatibleCurrent = current?.playerId === playerId ? current : null;
  if (!compatibleCurrent || incoming.revision > compatibleCurrent.revision) {
    return { accepted: true, snapshot: incoming };
  }
  if (
    incoming.revision === compatibleCurrent.revision &&
    samePersistentPolicy(compatibleCurrent, incoming)
  ) {
    return { accepted: true, snapshot: incoming };
  }
  return { accepted: false, snapshot: compatibleCurrent };
}

function samePersistentPolicy(
  left: InventoryProtectionSnapshot,
  right: InventoryProtectionSnapshot
): boolean {
  return JSON.stringify(materialPolicyIdentity(left)) ===
      JSON.stringify(materialPolicyIdentity(right)) &&
    JSON.stringify(uniquePolicyIdentity(left)) ===
      JSON.stringify(uniquePolicyIdentity(right));
}

function materialPolicyIdentity(snapshot: InventoryProtectionSnapshot): string[] {
  return snapshot.materialPolicies
    .map((policy) =>
      `${policy.itemId}\0${policy.variant ?? "default"}\0${policy.keepQuantity}`)
    .sort();
}

function uniquePolicyIdentity(snapshot: InventoryProtectionSnapshot): string[] {
  return snapshot.uniqueItems
    .filter((policy) => policy.protected)
    .map((policy) => policy.equipmentInstanceId)
    .sort();
}
