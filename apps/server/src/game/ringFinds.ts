import {
  RING_DEFINITION_IDS,
  type EquipmentSnapshotV2,
  type RingDefinitionId,
  type RingTier
} from "@ash-atlas/shared";
import type pg from "pg";

import { dropEquipmentToGroundInTransaction, type GroundPlacement } from "./droppedItems.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";
import type { EquipmentService } from "./equipment.js";

export type RingFindEquipment = Pick<
  EquipmentService,
  | "grantPackageInstancesInTransaction"
  | "insertOverflowRingInTransaction"
  | "snapshotInTransaction"
  | "installAuthoritativeSnapshot"
  | "runtimeSnapshot"
>;

/** An overworld loot-pile placement at `position` (same region/zone keys as combat loot). */
export function overworldRingGroundPlacement(
  position: Readonly<{ lat: number; lon: number }>,
  pileId: string,
  pileOrder = 1_000
): GroundPlacement {
  return {
    regionCode: packageIdForPosition(position),
    zoneId: zoneIdForPosition(position),
    pileId,
    pileOrder,
    position: { lat: position.lat, lon: position.lon },
    createdAt: new Date()
  };
}

export type RingFindResult = Readonly<{
  definitionId: RingDefinitionId;
  /** inventory, the ground at `ground` (full bag), skipped on a replay, or lost (full bag, no ground). */
  delivered: "inventory" | "ground" | "replayed" | "lost";
  lat?: number;
  lon?: number;
  equipment: EquipmentSnapshotV2 | null;
}>;

/**
 * Grants one found ring (mob drop, Deepstone rare find) inside the caller's transaction: into the
 * bag when it fits, else onto `ground` like other overflow loot. Idempotent per operation key.
 * The caller installs `equipment` into the runtime after its commit.
 */
export async function grantRingFindInTransaction(
  client: Pick<pg.PoolClient, "query">,
  equipment: RingFindEquipment,
  input: Readonly<{
    operationKey: string;
    playerId: string;
    tier: RingTier;
    source: string;
    ground: GroundPlacement | null;
  }>
): Promise<RingFindResult> {
  const definitionId = RING_DEFINITION_IDS[input.tier];
  const prior = await client.query("SELECT 1 FROM equipment_operations WHERE operation_key=$1", [input.operationKey]);
  if ((prior.rowCount ?? 0) > 0) return { definitionId, delivered: "replayed", equipment: null };
  const granted = await equipment.grantPackageInstancesInTransaction(client, {
    operationKey: input.operationKey,
    playerId: input.playerId,
    source: input.source,
    grants: [{ definitionId, quantity: 1 }]
  });
  if ((granted.grants[0]?.grantedQuantity ?? 0) > 0) {
    return { definitionId, delivered: "inventory", equipment: granted.equipment };
  }
  if (!input.ground) return { definitionId, delivered: "lost", equipment: granted.equipment };
  const instanceId = await equipment.insertOverflowRingInTransaction(client, {
    operationKey: input.operationKey,
    playerId: input.playerId,
    definitionId,
    source: input.source
  });
  const drop = await dropEquipmentToGroundInTransaction(client, {
    operationKey: `${input.operationKey}:ground`,
    playerId: input.playerId,
    instanceId,
    itemId: definitionId,
    placement: input.ground
  });
  return {
    definitionId,
    delivered: "ground",
    lat: drop.lat,
    lon: drop.lon,
    equipment: await equipment.snapshotInTransaction(client, input.playerId)
  };
}
