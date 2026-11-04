import type { EquipmentSnapshotV2 } from "@ash-atlas/shared";

export function acceptEquipmentSnapshot(
  ownPlayerId: string,
  current: EquipmentSnapshotV2 | null,
  incoming: EquipmentSnapshotV2
): EquipmentSnapshotV2 | null {
  if (incoming.playerId !== ownPlayerId) return current;
  if (!current) return incoming;
  if (current.playerId !== ownPlayerId) return current;
  return reconcileEquipmentSnapshot(current, incoming);
}

export function reconcileEquipmentSnapshot<
  Snapshot extends Pick<
    EquipmentSnapshotV2,
    "inventoryRevision" | "activeRevision" | "checkpointRevision"
  >
>(current: Snapshot | null, incoming: Snapshot): Snapshot {
  if (!current) return incoming;
  if (
    incoming.inventoryRevision < current.inventoryRevision ||
    incoming.activeRevision < current.activeRevision ||
    incoming.checkpointRevision < current.checkpointRevision
  ) {
    return current;
  }
  return incoming;
}
