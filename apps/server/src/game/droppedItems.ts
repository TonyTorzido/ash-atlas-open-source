import { createHash } from "node:crypto";

import {
  FACE_MASK_ITEM_ID,
  MANOR_SKIN_ITEM_ID,
  DROPPED_ITEM_PILE_MERGE_RADIUS_M,
  DROPPED_ITEM_PICKUP_RADIUS_M,
  distanceMeters,
  MANOR_DROPPED_EQUIPMENT_PICKUP_RADIUS,
  MANOR_DROPPED_ITEM_PICKUP_EPSILON,
  requireEquipmentDefinition,
  requireBackpackDefinition,
  requireBackpackLevel,
  getBackpackWeightGrams,
  type BackpackDefinitionId,
  type BackpackInstanceSnapshot,
  type BackpackSnapshot,
  type DroppedItemSnapshot,
  type DroppedItemStatus,
  type EquipmentDefinitionId,
  type LatLon,
  type PlayerInventorySnapshot,
  type ResourceType,
  type ManorSpaceId,
  type IndoorPoint
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  DEFAULT_INVENTORY_VARIANT,
  InventoryService,
  isInventoryCapacityError,
  assertInventoryWeightInTransaction,
  lockInventoryCapacity,
  inventoryQuantityToSafeNumber,
  type InventoryOperationInput,
  type InventoryOperationResult,
  type InventoryTransitionGrant
} from "./inventory.js";
import {
  lockInventoryProtection,
  materialProtectionAllocation
} from "./inventoryProtection.js";
import { requireItemDefinition, requireRuntimeItemDefinition } from "./items.js";
import { zoneIdForRegion, type PlayerRecord } from "./state.js";

export { DROPPED_ITEM_PICKUP_RADIUS_M } from "@ash-atlas/shared";
export { DROPPED_ITEM_PILE_MERGE_RADIUS_M } from "@ash-atlas/shared";
export const DROPPED_ITEM_TTL_MS = 60 * 60_000;
// PostgreSQL retains a finite timestamp for the wire contract while Manor
// rows are excluded from expiry. This avoids Date/JSON infinity edge cases.
const MANOR_PERSISTENT_DROP_EXPIRES_AT = new Date("9999-12-31T23:59:59.999Z");
// Drop IDs are UUID-shaped, but deterministic historical IDs are derived
// from hashes and do not promise RFC version/variant bits.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type DroppedItemErrorCode =
  | "DROP_UNKNOWN_ITEM"
  | "DROP_ITEM_NOT_STACKABLE"
  | "DROP_ITEM_NOT_DROPPABLE"
  | "DROP_ITEM_PROTECTED"
  | "DROP_STACK_LIMIT_EXCEEDED"
  | "DROP_INVALID_QUANTITY"
  | "DROP_INVALID_POSITION"
  | "DROP_INVALID_VARIANT"
  | "DROP_VARIANT_NOT_OWNED"
  | "DROP_NOT_ENOUGH_ITEMS"
  | "DROP_REPLAY_CONFLICT"
  | "DROP_EQUIPMENT_STALE"
  | "DROP_EQUIPMENT_NOT_ELIGIBLE"
  | "DROP_EQUIPMENT_REPLAY_CONFLICT"
  | "DROPPED_ITEM_NOT_FOUND"
  | "DROPPED_ITEM_ALREADY_PICKED_UP"
  | "DROPPED_ITEM_NOT_ACTIVE"
  | "DROPPED_ITEM_EXPIRED"
  | "DROPPED_ITEM_OUT_OF_RANGE"
  | "DROPPED_ITEM_INVALID_PICKUP_QUANTITY"
  | "DROPPED_ITEM_QUANTITY_UNAVAILABLE"
  | "DROPPED_ITEM_PICKUP_REPLAY_CONFLICT"
  | "DROPPED_ITEM_CARRY_CAPACITY_EXCEEDED"
  | "DROPPED_EQUIPMENT_INVENTORY_FULL"
  | "DROPPED_EQUIPMENT_PICKUP_REPLAY_CONFLICT"
  | "DROPPED_BACKPACK_PICKUP_REPLAY_CONFLICT"
  | "DROPPED_BACKPACK_CARRY_CAPACITY_EXCEEDED";

export class DroppedItemError extends Error {
  constructor(
    readonly code: DroppedItemErrorCode,
    message: string,
    readonly details?: { dropId?: string; remainingQuantity?: number }
  ) {
    super(message);
    this.name = "DroppedItemError";
  }
}

export type DropItemInput = {
  requestId: string;
  itemId: string;
  variant: string | null;
  quantity: number;
  stackId?: string;
};

/**
 * A resource drop. Omit-then-narrow keeps itemId a plain ResourceType; an
 * intersection with the wider itemId union exceeds the compiler's union limit.
 */
export type ResourceDroppedItemSnapshot = Omit<DroppedItemSnapshot, "itemId"> & Readonly<{ itemId: ResourceType }>;

export type DroppedItemResult = {
  drop: ResourceDroppedItemSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
};

export type DropEquipmentInput = Readonly<{
  requestId: string;
  equipmentInstanceId: string;
  expectedEquipmentRevision: number;
}>;

export type ManorEquipmentDropInput = Readonly<{
  requestId: string;
  equipmentInstanceId: string;
  expectedEquipmentRevision: number;
  manorId: string;
  spaceId: ManorSpaceId;
  position: IndoorPoint;
}>;

export type DroppedEquipmentResult = Readonly<{
  drop: DroppedItemSnapshot & Readonly<{
    itemId: EquipmentDefinitionId;
    equipmentInstanceId: string;
  }>;
  replayed: boolean;
}>;

export type DroppedBackpackResult = Readonly<{
  drop: DroppedItemSnapshot & Readonly<{
    itemId: BackpackDefinitionId;
    backpackInstanceId: string;
    backpack: BackpackInstanceSnapshot;
  }>;
  backpacks: BackpackSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

export type DroppedItemPickupIntent =
  | { mode: "all" }
  | { mode: "quantity"; quantity: number };

export type DroppedItemPickupResult = DroppedItemResult & {
  requestedQuantity: number;
  pickedUpQuantity: number;
  remainingQuantity: number;
  removed: boolean;
};

export type SystemGroundDropLine = Readonly<{
  itemId: string;
  variant: string | null;
  quantity: number;
  pileOrder?: number;
}>;

export type SystemGroundDropInput = Readonly<{
  operationKey: string;
  droppedByPlayerId: string;
  regionCode: string;
  zoneId?: string;
  pileId?: string;
  sourceEntityType?: string;
  sourceEntityId?: string;
  position: LatLon;
  reason: string;
  lines: readonly SystemGroundDropLine[];
  now?: Date;
}>;

type PhysicalRewardInventory = Pick<
  InventoryService,
  "grantItemsForOperationInTransaction" | "snapshotInTransaction"
>;

type PhysicalRewardGroundInput = Omit<SystemGroundDropInput, "lines">;

export type PhysicalItemRewardSettlement = Readonly<{
  inventory: PlayerInventorySnapshot;
  inventoryGrant: InventoryOperationResult | null;
  droppedItems: DroppedItemSnapshot[];
}>;

export async function createPhysicalRewardOverflowDropsInTransaction(
  client: Queryable,
  inventoryGrant: InventoryOperationResult,
  groundDrop: PhysicalRewardGroundInput
): Promise<DroppedItemSnapshot[]> {
  return createSystemGroundDropsInTransaction(client, {
    ...groundDrop,
    lines: inventoryGrant.grants.flatMap((grant, pileOrder) =>
      grant.remainderQuantity > 0
        ? [{
            itemId: grant.itemId,
            variant: grant.variant,
            quantity: grant.remainderQuantity,
            pileOrder
          }]
        : []
    )
  });
}

export async function settlePhysicalItemRewardInTransaction(
  client: Queryable,
  inventory: PhysicalRewardInventory,
  input:
    | Readonly<{
        delivery: "ground";
        playerId: string;
        lines: readonly InventoryTransitionGrant[];
        groundDrop: PhysicalRewardGroundInput;
      }>
    | Readonly<{
        delivery: "inventory_then_ground";
        lines: readonly InventoryTransitionGrant[];
        inventoryOperation: Omit<InventoryOperationInput, "allowPartial" | "grants">;
        groundDrop: PhysicalRewardGroundInput;
      }>
): Promise<PhysicalItemRewardSettlement> {
  if (input.delivery === "ground") {
    return {
      inventory: await inventory.snapshotInTransaction(client, input.playerId),
      inventoryGrant: null,
      droppedItems: await createSystemGroundDropsInTransaction(client, {
        ...input.groundDrop,
        lines: input.lines.map((line, pileOrder) => ({
          itemId: line.itemId,
          variant: line.variant ?? null,
          quantity: typeof line.quantity === "bigint"
            ? inventoryQuantityToSafeNumber(line.quantity)
            : line.quantity,
          pileOrder
        }))
      })
    };
  }
  const inventoryGrant = await inventory.grantItemsForOperationInTransaction(client, {
    ...input.inventoryOperation,
    allowPartial: true,
    grants: [...input.lines]
  });
  return {
    inventory: inventoryGrant.inventory,
    inventoryGrant,
    droppedItems: await createPhysicalRewardOverflowDropsInTransaction(
      client,
      inventoryGrant,
      input.groundDrop
    )
  };
}

export type DroppedItemActor = Pick<PlayerRecord, "playerId" | "regionCode" | "position"> & {
  zoneId?: string;
  manorId?: string;
  spaceId?: ManorSpaceId;
  localPosition?: IndoorPoint;
};

export async function createSystemGroundDropsInTransaction(
  client: Queryable,
  input: SystemGroundDropInput
): Promise<DroppedItemSnapshot[]> {
  const createdAt = input.now ?? new Date();
  const expiresAt = new Date(createdAt.getTime() + DROPPED_ITEM_TTL_MS);
  const drops: DroppedItemSnapshot[] = [];
  const preparedLines = input.lines.flatMap((line, lineIndex) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) return [];
    const item = requireDroppableItem(line.itemId);
    return [{ line, lineIndex, item, variant: normalizeVariant(line.variant) }];
  });
  const zoneId = input.zoneId ?? zoneIdForRegion(input.regionCode);
  await lockGroundDropPileKeys(client, zoneId, preparedLines);
  const nearbyPile = await findNearbyGroundDropPile(client, {
    regionCode: input.regionCode,
    zoneId,
    position: input.position,
    compatibleItems: preparedLines,
    now: createdAt
  });
  const pileId = nearbyPile?.pileId ?? input.pileId ?? `system:${input.operationKey}`;
  const pilePosition = nearbyPile?.position ?? input.position;
  const pileOrderOffset = nearbyPile?.nextPileOrder ?? 0;
  for (const { line, lineIndex, item, variant } of preparedLines) {
    // Ground piles preserve a whole logical quantity; this is only the wire integer bound.
    const maximum = Number.MAX_SAFE_INTEGER;
    let remaining = line.quantity;
    let chunkIndex = 0;
    while (remaining > 0) {
      const operationPileOrder = line.pileOrder ?? lineIndex;
      const operationKey = line.pileOrder === undefined
        ? `${input.operationKey}:${line.itemId}:${variant}:${chunkIndex}`
        : `${input.operationKey}:${operationPileOrder}:${line.itemId}:${variant}:${chunkIndex}`;
      const replay = await replaySystemGroundDropContribution(client, operationKey);
      if (replay) {
        drops.push(replay.drop);
        remaining -= replay.contributedQuantity;
        chunkIndex += 1;
        continue;
      }
      const existing = await findMergeableSystemGroundDropStack(client, {
        zoneId,
        pileId,
        itemId: item.itemId,
        variant,
        now: createdAt,
        maximum
      });
      const existingQuantity = existing
        ? inventoryQuantityToSafeNumber(existing.original_quantity)
        : 0;
      const quantity = Math.min(remaining, maximum - existingQuantity);
      const dropId = existing?.id ?? dropIdForOperation(operationKey);
      const operation = await client.query(
        `INSERT INTO inventory_operations (
           operation_key,player_id,source,source_entity_type,source_entity_id,metadata
         ) VALUES ($1,$2,'world_system_drop',$3,$4,$5::jsonb)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [
          operationKey,
          input.droppedByPlayerId,
          "world_item_drop",
          dropId,
          JSON.stringify({
            reason: input.reason,
            itemId: line.itemId,
            variant,
            quantity
          })
        ]
      );
      if (operation.rowCount !== 1) {
        const concurrentReplay = await replaySystemGroundDropContribution(client, operationKey);
        if (!concurrentReplay) {
          throw new Error("System ground-drop operation lacks durable contribution truth");
        }
        drops.push(concurrentReplay.drop);
        remaining -= concurrentReplay.contributedQuantity;
        chunkIndex += 1;
        continue;
      }
      let inserted: pg.QueryResult<DroppedItemRow>;
      if (existing) {
        await client.query(
          "SELECT set_config('ash_atlas.system_ground_drop_merge', $1, true)",
          [dropId]
        );
        inserted = await client.query<DroppedItemRow>(
          `UPDATE world_item_drops
           SET original_quantity = original_quantity + $2::bigint,
               remaining_quantity = remaining_quantity + $2::bigint,
               expires_at = GREATEST(expires_at, $3)
           WHERE id = $1
             AND status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM world_item_pickups pickup WHERE pickup.drop_id = $1
             )
           RETURNING ${DROP_COLUMNS}`,
          [dropId, quantity, expiresAt]
        );
      } else {
        inserted = await client.query<DroppedItemRow>(
          `INSERT INTO world_item_drops (
             id,operation_key,dropped_by,region_code,zone_id,pile_id,pile_order,item_id,variant,
             original_quantity,remaining_quantity,status,lat,lon,geom,
             created_at,expires_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,$10::bigint,'active',$11,$12,
             ST_SetSRID(ST_MakePoint($12,$11),4326),$13,$14
           )
           RETURNING ${DROP_COLUMNS}`,
          [
            dropId,
            operationKey,
            input.droppedByPlayerId,
            input.regionCode,
            zoneId,
            pileId,
            pileOrderOffset + operationPileOrder,
            item.itemId,
            variant,
            quantity,
            pilePosition.lat,
            pilePosition.lon,
            createdAt,
            expiresAt
          ]
        );
      }
      const row = requireDropRow(inserted.rows[0]);
      await client.query(
        `INSERT INTO world_item_system_drop_sources (
           drop_id,operation_key,source_entity_type,source_entity_id,reason,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          dropId,
          operationKey,
          input.sourceEntityType ?? "destruction_refund",
          input.sourceEntityId ?? input.operationKey,
          input.reason,
          createdAt
        ]
      );
      await client.query(
        `INSERT INTO world_item_movements (
           drop_id,movement_kind,operation_key,pickup_operation_key,player_id,
           item_id,variant,quantity,reason,created_at
         ) VALUES (
           $1,'system_to_world',$2,NULL,$3,$4,$5,$6::bigint,$7,$8
         )
         ON CONFLICT DO NOTHING`,
        [
          dropId,
          operationKey,
          input.droppedByPlayerId,
          item.itemId,
          variant,
          quantity,
          input.reason,
          createdAt
        ]
      );
      drops.push(rowToSnapshot(row));
      remaining -= quantity;
      chunkIndex += 1;
    }
  }
  return drops;
}

type Queryable = Pick<pg.PoolClient, "query">;

type GroundDropPileItem = Readonly<{
  item: Readonly<{ itemId: ResourceType }>;
  variant: string;
}>;

type GroundDropPilePlacement = Readonly<{
  pileId: string;
  nextPileOrder: number;
  position: LatLon;
}>;

type ManorDropProjection = Readonly<{
  manorId: string;
  spaceId: ManorSpaceId;
  position: IndoorPoint;
}>;

type ManorDropPilePlacement = Readonly<{
  pileId: string;
  nextPileOrder: number;
}>;

function manorDropProjection(player: DroppedItemActor): ManorDropProjection | null {
  if (!player.manorId && !player.spaceId && !player.localPosition) return null;
  if (
    !player.manorId ||
    !player.spaceId ||
    !player.localPosition ||
    !Number.isFinite(player.localPosition.x) ||
    !Number.isFinite(player.localPosition.y) ||
    Math.abs(player.localPosition.x) > Number.MAX_SAFE_INTEGER ||
    Math.abs(player.localPosition.y) > Number.MAX_SAFE_INTEGER
  ) {
    throw new DroppedItemError(
      "DROP_INVALID_POSITION",
      "Manor floor-drop position is invalid"
    );
  }
  return {
    manorId: player.manorId,
    spaceId: player.spaceId,
    position: player.localPosition
  };
}

type MergeableSystemGroundDropInput = Readonly<{
  zoneId: string;
  pileId: string;
  itemId: ResourceType;
  variant: string;
  now: Date;
  maximum: number;
}>;

async function lockGroundDropPileKeys(
  queryable: Queryable,
  zoneId: string,
  items: readonly GroundDropPileItem[]
): Promise<void> {
  const keys = [...new Set(items.map(({ item, variant }) =>
    `world-item-pile:${zoneId}:${item.itemId}:${variant}`
  ))].sort();
  for (const key of keys) {
    await queryable.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key]
    );
  }
}

async function findNearbyGroundDropPile(
  queryable: Queryable,
  input: Readonly<{
    regionCode: string;
    zoneId: string;
    position: LatLon;
    compatibleItems: readonly GroundDropPileItem[];
    now: Date;
  }>
): Promise<GroundDropPilePlacement | null> {
  if (input.compatibleItems.length === 0) return null;
  const itemIds = input.compatibleItems.map(({ item }) => item.itemId);
  const variants = input.compatibleItems.map(({ variant }) => variant);
  const result = await queryable.query<{
    pile_id: string;
    next_pile_order: number;
    lat: number;
    lon: number;
  }>(
    `SELECT candidate.pile_id,
            candidate.lat,
            candidate.lon,
            (
              SELECT COALESCE(MAX(member.pile_order), -1) + 1
              FROM world_item_drops member
              WHERE member.zone_id = candidate.zone_id
                AND member.pile_id = candidate.pile_id
                AND member.status = 'active'
            )::integer AS next_pile_order
     FROM world_item_drops candidate
     WHERE candidate.region_code = $1
       AND candidate.zone_id = $2
       AND candidate.status = 'active'
       AND candidate.expires_at > $7
       AND EXISTS (
         SELECT 1
         FROM unnest($5::text[], $6::text[]) compatible(item_id, variant)
         WHERE compatible.item_id = candidate.item_id
           AND compatible.variant = candidate.variant
       )
       AND ST_DWithin(
         candidate.geom::geography,
         ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
         $8
       )
     ORDER BY ST_Distance(
                candidate.geom::geography,
                ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography
              ),
              candidate.created_at,
              candidate.id
     LIMIT 1`,
    [
      input.regionCode,
      input.zoneId,
      input.position.lat,
      input.position.lon,
      itemIds,
      variants,
      input.now,
      DROPPED_ITEM_PILE_MERGE_RADIUS_M
    ]
  );
  const row = result.rows[0];
  return row
    ? {
        pileId: row.pile_id,
        nextPileOrder: Number(row.next_pile_order),
        position: { lat: Number(row.lat), lon: Number(row.lon) }
      }
    : null;
}

async function findNearbyManorDropPile(
  queryable: Queryable,
  input: Readonly<{
    manorId: string;
    spaceId: ManorSpaceId;
    position: IndoorPoint;
    stackable: boolean;
  }>
): Promise<ManorDropPilePlacement | null> {
  if (!input.stackable) return null;
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`manor-item-pile:${input.manorId}:${input.spaceId}`]
  );
  const result = await queryable.query<{
    pile_id: string;
    next_pile_order: number;
  }>(
    `WITH active_drops AS MATERIALIZED (
       SELECT candidate.pile_id, candidate.pile_order,
              candidate.local_x, candidate.local_y,
              candidate.created_at, candidate.id::text AS drop_id
       FROM world_item_drops candidate
       WHERE candidate.manor_id = $1::uuid
         AND candidate.space_id = $2
         AND candidate.status = 'active'
       UNION ALL
       SELECT candidate.pile_id, candidate.pile_order,
              candidate.local_x, candidate.local_y,
              candidate.created_at, candidate.id::text AS drop_id
       FROM world_equipment_drops candidate
       WHERE candidate.manor_id = $1::uuid
         AND candidate.space_id = $2
         AND candidate.status = 'active'
       UNION ALL
       SELECT candidate.pile_id, candidate.pile_order,
              candidate.local_x, candidate.local_y,
              candidate.created_at, candidate.id::text AS drop_id
       FROM world_backpack_drops candidate
       WHERE candidate.manor_id = $1::uuid
         AND candidate.space_id = $2
         AND candidate.status = 'active'
     ), nearest AS (
       SELECT candidate.pile_id
       FROM active_drops candidate
       WHERE candidate.local_x IS NOT NULL
         AND candidate.local_y IS NOT NULL
         AND sqrt(
           power(candidate.local_x - $3::double precision, 2) +
           power(candidate.local_y - $4::double precision, 2)
         ) <= $5
       ORDER BY sqrt(
           power(candidate.local_x - $3::double precision, 2) +
           power(candidate.local_y - $4::double precision, 2)
         ), candidate.created_at, candidate.drop_id
       LIMIT 1
     )
     SELECT nearest.pile_id,
            (
              SELECT COALESCE(MAX(member.pile_order), -1) + 1
              FROM active_drops member
              WHERE member.pile_id = nearest.pile_id
            )::integer AS next_pile_order
     FROM nearest`,
    [
      input.manorId,
      input.spaceId,
      input.position.x,
      input.position.y,
      MANOR_DROPPED_EQUIPMENT_PICKUP_RADIUS
    ]
  );
  const row = result.rows[0];
  return row
    ? { pileId: row.pile_id, nextPileOrder: Number(row.next_pile_order) }
    : null;
}

async function findMergeableSystemGroundDropStack(
  queryable: Queryable,
  input: MergeableSystemGroundDropInput
): Promise<DroppedItemRow | null> {
  const result = await queryable.query<DroppedItemRow>(
    `SELECT ${DROP_COLUMNS}
     FROM world_item_drops candidate
     WHERE candidate.zone_id = $1
       AND candidate.pile_id = $2
       AND candidate.item_id = $3
       AND candidate.variant = $4
       AND candidate.status = 'active'
       AND candidate.expires_at > $5
       AND candidate.original_quantity < $6::bigint
       AND EXISTS (
         SELECT 1 FROM world_item_system_drop_sources source
         WHERE source.drop_id = candidate.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM world_item_pickups pickup
         WHERE pickup.drop_id = candidate.id
       )
     ORDER BY candidate.pile_order, candidate.created_at, candidate.id
     LIMIT 1
     FOR UPDATE`,
    [input.zoneId, input.pileId, input.itemId, input.variant, input.now, input.maximum]
  );
  return result.rows[0] ?? null;
}

type DroppedItemRow = {
  id: string;
  operation_key: string;
  dropped_by: string;
  region_code: string;
  zone_id: string;
  pile_id: string;
  pile_order: number;
  item_id: string;
  variant: string;
  original_quantity: string;
  remaining_quantity: string;
  status: DroppedItemStatus;
  lat: number;
  lon: number;
  created_at: Date | string;
  expires_at: Date | string;
  expired_at: Date | string | null;
  pickup_operation_key: string | null;
  picked_up_by: string | null;
  picked_up_at: Date | string | null;
  manor_id: string | null;
  space_id: ManorSpaceId | null;
  local_x: number | null;
  local_y: number | null;
};

type DroppedItemPickupRow = {
  operation_key: string;
  drop_id: string;
  player_id: string;
  pickup_mode: "all" | "quantity";
  requested_quantity: string | null;
  granted_quantity: string;
  remaining_quantity: string;
  resulting_status: "active" | "picked_up";
};

type InventoryGateway = Pick<
  InventoryService,
  "debitItemsForOperationInTransaction" |
  "grantItemsForOperationInTransaction" |
  "snapshotInTransaction"
>;

type DropRequestRow = {
  request_hash: string;
  original_result: {
    drop?: DroppedItemResult["drop"];
    inventory?: PlayerInventorySnapshot;
  };
};

type EquipmentDropRow = {
  id: string;
  operation_key: string;
  equipment_instance_id: string;
  item_id: EquipmentDefinitionId;
  dropped_by: string;
  region_code: string;
  zone_id: string;
  pile_id: string;
  pile_order: number;
  status: "active" | "picked_up" | "expired";
  lat: number;
  lon: number;
  created_at: Date | string;
  expires_at: Date | string;
  expired_at: Date | string | null;
  pickup_operation_key: string | null;
  picked_up_by: string | null;
  picked_up_at: Date | string | null;
  manor_id: string | null;
  space_id: ManorSpaceId | null;
  local_x: number | null;
  local_y: number | null;
};

type BackpackDropRow = {
  id: string;
  operation_key: string;
  backpack_instance_id: string;
  dropped_by: string;
  region_code: string;
  zone_id: string;
  pile_id: string;
  pile_order: number;
  status: "active" | "picked_up" | "expired";
  lat: number;
  lon: number;
  created_at: Date | string;
  expires_at: Date | string;
  pickup_operation_key: string | null;
  picked_up_by: string | null;
  picked_up_at: Date | string | null;
  manor_id: string | null;
  space_id: ManorSpaceId | null;
  local_x: number | null;
  local_y: number | null;
  owner_player_id: string;
  definition_id: BackpackDefinitionId;
  upgrade_level: number;
  backpack_location: "inventory" | "equipped" | "manor_storage" | "world_drop" | "destroyed";
  equipped_slot: number | null;
  inventory_slot_index: number | null;
  backpack_manor_id: string | null;
  manor_slot_index: number | null;
  backpack_version: string;
  backpack_created_at: Date | string;
  backpack_updated_at: Date | string;
};

type BackpackDropOperationRow = {
  player_id: string;
  request_id: string;
  action: "manor_storage_recovery" | "pickup";
  request_hash: string;
  instance_id: string;
  drop_id: string | null;
  original_result: {
    drop?: DroppedBackpackResult["drop"];
    backpacks?: BackpackSnapshot;
    inventory?: PlayerInventorySnapshot;
  } | null;
  completed_at: Date | string | null;
};

type GroundEquipmentOperationRow = {
  player_id: string;
  action: "ground_drop" | "ground_pickup" | "ground_expire";
  instance_id: string;
  result: { dropId?: string } | null;
  completed_at: Date | string | null;
};

export class DroppedItemService {
  private readonly inventory: InventoryGateway;

  constructor(
    private readonly pool: pg.Pool,
    inventory?: InventoryGateway,
    private readonly now: () => Date = () => new Date()
  ) {
    this.inventory = inventory ?? new InventoryService(pool);
  }

  async resolveDropKind(dropId: string): Promise<"item" | "equipment" | "backpack" | null> {
    if (!UUID_RE.test(dropId)) return null;
    const result = await this.pool.query<{ kind: "item" | "equipment" | "backpack" }>(
      `SELECT kind FROM (
         SELECT 'item'::text AS kind FROM world_item_drops WHERE id=$1::uuid
         UNION ALL
         SELECT 'equipment'::text AS kind FROM world_equipment_drops WHERE id=$1::uuid
         UNION ALL
         SELECT 'backpack'::text AS kind FROM world_backpack_drops WHERE id=$1::uuid
       ) candidates
       ORDER BY CASE kind WHEN 'item' THEN 1 WHEN 'equipment' THEN 2 ELSE 3 END
       LIMIT 1`,
      [dropId]
    );
    return result.rows[0]?.kind ?? null;
  }

  /** Compatibility helper for older callers; pickup dispatch uses resolveDropKind. */
  async isEquipmentDrop(dropId: string): Promise<boolean> {
    return (await this.resolveDropKind(dropId)) === "equipment";
  }

  async dropItem(
    player: DroppedItemActor,
    input: DropItemInput
  ): Promise<DroppedItemResult> {
    const item = requireDroppableItem(input.itemId);
    const quantity = requirePositiveQuantity(input.quantity);
    const variant = normalizeVariant(input.variant);
    const operationKey = requestOperationKey("drop", player.playerId, input.requestId);
    const requestHash = dropIntentHash(
      player.playerId,
      item.itemId,
      variant,
      quantity,
      input.stackId ?? null
    );
    const dropId = dropIdForOperation(operationKey);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const zoneId = player.zoneId ?? zoneIdForRegion(player.regionCode);
      const manorDrop = manorDropProjection(player);
      const replay = await replayDropRequest(
        client,
        this.inventory,
        operationKey,
        player.playerId,
        requestHash
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }

      await lockInventoryProtection(client, player.playerId);
      const beforeDebit = await this.inventory.snapshotInTransaction(client, player.playerId);
      const ownedStack = beforeDebit.items.find(
        (stack) => (!input.stackId || stack.stackId === input.stackId) &&
          stack.resourceType === item.itemId &&
          (stack.variant ?? DEFAULT_INVENTORY_VARIANT) === variant
      );
      if (!ownedStack) {
        throw new DroppedItemError(
          "DROP_VARIANT_NOT_OWNED",
          "Cannot drop this item variant because it is not owned"
        );
      }
      if (ownedStack.quantity < quantity) {
        throw new DroppedItemError("DROP_NOT_ENOUGH_ITEMS", "Not enough items to drop");
      }
      if (!ownedStack.stackId) {
        throw new DroppedItemError("DROP_VARIANT_NOT_OWNED", "Inventory stack identity is missing");
      }
      const protection = await materialProtectionAllocation(client, player.playerId);
      const allocation = protection.byStackId.get(ownedStack.stackId);
      const movable = allocation?.movableQuantity ?? ownedStack.quantity;
      if (movable < quantity) {
        throw new DroppedItemError(
          "DROP_ITEM_PROTECTED",
          (item.itemId === MANOR_SKIN_ITEM_ID || item.itemId === FACE_MASK_ITEM_ID) && movable === 0 && allocation?.reason
            ? allocation.reason
            : `Only ${movable.toLocaleString()} can be dropped; the rest is protected`
        );
      }

      const createdAt = this.now();
      const expiresAt = manorDrop
        ? MANOR_PERSISTENT_DROP_EXPIRES_AT
        : new Date(createdAt.getTime() + DROPPED_ITEM_TTL_MS);
      let debit;
      try {
        debit = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey,
          playerId: player.playerId,
          source: "drop_item",
          sourceEntityType: "world_item_drop",
          sourceEntityId: dropId,
          metadata: { requestId: input.requestId, requestHash },
          ...(input.stackId ? { preferredStackId: input.stackId } : {}),
          debits: [{ itemId: item.itemId, variant: snapshotVariant(variant), quantity }]
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("enough items")) {
          throw new DroppedItemError("DROP_NOT_ENOUGH_ITEMS", "Not enough items to drop");
        }
        throw error;
      }
      if (!debit.applied) {
        const concurrentReplay = await replayDropRequest(
          client,
          this.inventory,
          operationKey,
          player.playerId,
          requestHash
        );
        if (!concurrentReplay) {
          throw new DroppedItemError(
            "DROP_REPLAY_CONFLICT",
            "Drop request has an inventory transition without durable drop truth"
          );
        }
        await client.query("COMMIT");
        return concurrentReplay;
      }

      const nearbyPile = manorDrop
        ? await findNearbyManorDropPile(client, {
            manorId: manorDrop.manorId,
            spaceId: manorDrop.spaceId,
            position: manorDrop.position,
            stackable: item.stackable
          })
        : await (async () => {
            await lockGroundDropPileKeys(client, zoneId, [{ item, variant }]);
            return findNearbyGroundDropPile(client, {
              regionCode: player.regionCode,
              zoneId,
              position: player.position,
              compatibleItems: [{ item, variant }],
              now: createdAt
            });
          })();
      const pileId = nearbyPile?.pileId ?? `drop:${dropId}`;
      const pileOrder = nearbyPile?.nextPileOrder ?? 0;
      const pilePosition: LatLon = nearbyPile && "position" in nearbyPile
        ? (nearbyPile as GroundDropPilePlacement).position
        : player.position;
      const inserted = manorDrop
        ? await client.query<DroppedItemRow>(
            `
            INSERT INTO world_item_drops (
              id, operation_key, dropped_by, region_code, zone_id, pile_id, pile_order,
              item_id, variant,
              original_quantity, remaining_quantity, status, lat, lon, geom,
              created_at, expires_at, manor_id, space_id, local_x, local_y
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $10::bigint,
              'active', 0, 0, ST_SetSRID(ST_MakePoint(0, 0), 4326), $11, $12,
              $13::uuid, $14, $15, $16
            )
            RETURNING ${DROP_COLUMNS}
            `,
            [
              dropId,
              operationKey,
              player.playerId,
              player.regionCode,
              zoneId,
              pileId,
              pileOrder,
              item.itemId,
              variant,
              quantity,
              createdAt,
              expiresAt,
              manorDrop.manorId,
              manorDrop.spaceId,
              manorDrop.position.x,
              manorDrop.position.y
            ]
          )
        : await client.query<DroppedItemRow>(
            `
            INSERT INTO world_item_drops (
              id, operation_key, dropped_by, region_code, zone_id, pile_id, pile_order,
              item_id, variant,
              original_quantity, remaining_quantity, status, lat, lon, geom,
              created_at, expires_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $10::bigint,
              'active', $11, $12, ST_SetSRID(ST_MakePoint($12, $11), 4326), $13, $14
            )
            RETURNING ${DROP_COLUMNS}
            `,
            [
              dropId,
              operationKey,
              player.playerId,
              player.regionCode,
              zoneId,
              pileId,
              pileOrder,
              item.itemId,
              variant,
              quantity,
              pilePosition.lat,
              pilePosition.lon,
              createdAt,
              expiresAt
            ]
          );
      const drop = requireDropRow(inserted.rows[0]);
      const dropSnapshot = rowToSnapshot(drop);
      await client.query(
        `INSERT INTO world_item_drop_requests (
           operation_key, drop_id, player_id, request_hash, original_result, created_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          operationKey,
          dropId,
          player.playerId,
          requestHash,
          JSON.stringify({ drop: dropSnapshot, inventory: debit.inventory }),
          createdAt
        ]
      );
      await client.query(
        `INSERT INTO world_item_movements (
           drop_id, movement_kind, operation_key, player_id, item_id, variant,
           quantity, reason, created_at
         ) VALUES ($1,'player_to_world',$2,$3,$4,$5,$6::bigint,'drop_created',$7)`,
        [dropId, operationKey, player.playerId, item.itemId, variant, quantity, createdAt]
      );
      await client.query("COMMIT");
      return { drop: dropSnapshot, inventory: debit.inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDropError(error);
    } finally {
      client.release();
    }
  }

  async dropEquipment(
    player: PlayerRecord & { zoneId?: string },
    input: DropEquipmentInput
  ): Promise<DroppedEquipmentResult> {
    const operationKey = requestOperationKey(
      "equipment-drop",
      player.playerId,
      input.requestId
    );
    const dropId = dropIdForOperation(operationKey);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await replayEquipmentDrop(
        client,
        operationKey,
        player.playerId,
        input.equipmentInstanceId
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const state = await client.query<{ inventory_revision: string }>(
        `SELECT inventory_revision::text
         FROM player_equipment_state
         WHERE player_id = $1
         FOR UPDATE`,
        [player.playerId]
      );
      if (
        BigInt(state.rows[0]?.inventory_revision ?? "-1") !==
        BigInt(input.expectedEquipmentRevision)
      ) {
        throw new DroppedItemError(
          "DROP_EQUIPMENT_STALE",
          "Equipment Inventory changed; refresh and try again"
        );
      }
      const selected = await client.query<{
        instance_id: string;
        definition_id: EquipmentDefinitionId;
        owner_player_id: string;
        location: string;
        inventory_slot_index: number | null;
        ring_rough: boolean;
      }>(
        `SELECT instance_id::text,definition_id,owner_player_id,location,
                inventory_slot_index,ring_rough
         FROM equipment_instances
         WHERE instance_id = $1
         FOR UPDATE`,
        [input.equipmentInstanceId]
      );
      const instance = selected.rows[0];
      if (
        !instance ||
        instance.owner_player_id !== player.playerId ||
        instance.location !== "inventory"
      ) {
        throw new DroppedItemError(
          "DROP_EQUIPMENT_NOT_ELIGIBLE",
          "This exact equipment item is not available in Inventory"
        );
      }
      requireEquipmentDefinition(instance.definition_id);
      if (instance.ring_rough) {
        throw new DroppedItemError("DROP_EQUIPMENT_NOT_ELIGIBLE", "Polish this ring before you drop it");
      }
      const blocked = await client.query<{ blocked: boolean }>(
        `SELECT (
           EXISTS (
             SELECT 1 FROM player_unique_item_protections protection
             WHERE protection.player_id = $1
               AND protection.equipment_instance_id = $2
               AND protection.protected
           )
           OR EXISTS (
             SELECT 1 FROM combat_kit_items kit
             WHERE kit.player_id = $1 AND kit.instance_id = $2
           )
           OR EXISTS (
             SELECT 1 FROM equipment_operations operation
             WHERE operation.player_id = $1
               AND operation.instance_id = $2
               AND operation.completed_at IS NULL
           )
         ) AS blocked`,
        [player.playerId, input.equipmentInstanceId]
      );
      if (blocked.rows[0]?.blocked) {
        throw new DroppedItemError(
          "DROP_EQUIPMENT_NOT_ELIGIBLE",
          "Protected, saved-kit, or pending equipment cannot be dropped"
        );
      }
      await client.query(
        `INSERT INTO equipment_operations (
           operation_key,player_id,action,instance_id
         ) VALUES ($1,$2,'ground_drop',$3)`,
        [operationKey, player.playerId, input.equipmentInstanceId]
      );
      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + DROPPED_ITEM_TTL_MS);
      const zoneId = player.zoneId ?? zoneIdForRegion(player.regionCode);
      const inserted = await client.query<EquipmentDropRow>(
        `INSERT INTO world_equipment_drops (
           id,operation_key,equipment_instance_id,item_id,dropped_by,
           region_code,zone_id,pile_id,pile_order,status,lat,lon,geom,
           created_at,expires_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,0,'active',$9,$10,
           ST_SetSRID(ST_MakePoint($10,$9),4326),$11,$12
         )
         RETURNING ${EQUIPMENT_DROP_COLUMNS}`,
        [
          dropId,
          operationKey,
          input.equipmentInstanceId,
          instance.definition_id,
          player.playerId,
          player.regionCode,
          zoneId,
          `equipment:${dropId}`,
          player.position.lat,
          player.position.lon,
          createdAt,
          expiresAt
        ]
      );
      const moved = await client.query(
        `UPDATE equipment_instances
         SET location='world_drop',inventory_slot_index=NULL
         WHERE instance_id=$1 AND owner_player_id=$2 AND location='inventory'`,
        [input.equipmentInstanceId, player.playerId]
      );
      if (moved.rowCount !== 1) {
        throw new DroppedItemError(
          "DROP_EQUIPMENT_STALE",
          "Equipment location changed before the drop committed"
        );
      }
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+1
         WHERE player_id=$1`,
        [player.playerId]
      );
      await client.query(
        `UPDATE equipment_operations
         SET result=$2::jsonb,completed_at=$3
         WHERE operation_key=$1`,
        [operationKey, JSON.stringify({ dropId }), createdAt]
      );
      const drop = equipmentRowToSnapshot(requireEquipmentDropRow(inserted.rows[0]));
      await client.query("COMMIT");
      return { drop, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDropError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Transfer one eligible equipment instance to an exact Manor-local floor
   * position. This intentionally remains a floor-only hook; house/spill
   * placement is a separate future mechanic and is not accepted here.
   */
  async dropManorEquipment(
    playerId: string,
    input: ManorEquipmentDropInput
  ): Promise<DroppedEquipmentResult> {
    if (!Number.isFinite(input.position.x) || !Number.isFinite(input.position.y)) {
      throw new DroppedItemError("DROP_EQUIPMENT_NOT_ELIGIBLE", "Manor equipment position is invalid");
    }
    const operationKey = requestOperationKey(
      "manor-equipment-drop",
      playerId,
      input.requestId
    );
    const dropId = dropIdForOperation(operationKey);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await replayEquipmentDrop(
        client,
        operationKey,
        playerId,
        input.equipmentInstanceId
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const state = await client.query<{ inventory_revision: string }>(
        `SELECT inventory_revision::text
         FROM player_equipment_state
         WHERE player_id = $1
         FOR UPDATE`,
        [playerId]
      );
      if (BigInt(state.rows[0]?.inventory_revision ?? "-1") !==
          BigInt(input.expectedEquipmentRevision)) {
        throw new DroppedItemError(
          "DROP_EQUIPMENT_STALE",
          "Equipment Inventory changed; refresh and try again"
        );
      }
      const selected = await client.query<{
        instance_id: string;
        definition_id: EquipmentDefinitionId;
        owner_player_id: string;
        location: string;
        ring_rough: boolean;
      }>(
        `SELECT instance_id::text,definition_id,owner_player_id,location,ring_rough
         FROM equipment_instances
         WHERE instance_id = $1
         FOR UPDATE`,
        [input.equipmentInstanceId]
      );
      const instance = selected.rows[0];
      if (!instance || instance.owner_player_id !== playerId || instance.location !== "inventory") {
        throw new DroppedItemError(
          "DROP_EQUIPMENT_NOT_ELIGIBLE",
          "This exact equipment item is not available in Inventory"
        );
      }
      requireEquipmentDefinition(instance.definition_id);
      if (instance.ring_rough) {
        throw new DroppedItemError("DROP_EQUIPMENT_NOT_ELIGIBLE", "Polish this ring before you drop it");
      }
      const blocked = await client.query<{ blocked: boolean }>(
        `SELECT (
           EXISTS (
             SELECT 1 FROM player_unique_item_protections protection
             WHERE protection.player_id = $1
               AND protection.equipment_instance_id = $2
               AND protection.protected
           )
           OR EXISTS (
             SELECT 1 FROM combat_kit_items kit
             WHERE kit.player_id = $1 AND kit.instance_id = $2
           )
           OR EXISTS (
             SELECT 1 FROM equipment_operations operation
             WHERE operation.player_id = $1
               AND operation.instance_id = $2
               AND operation.completed_at IS NULL
           )
         ) AS blocked`,
        [playerId, input.equipmentInstanceId]
      );
      if (blocked.rows[0]?.blocked) {
        throw new DroppedItemError(
          "DROP_EQUIPMENT_NOT_ELIGIBLE",
          "Protected, saved-kit, or pending equipment cannot be dropped"
        );
      }
      await client.query(
        `INSERT INTO equipment_operations (
           operation_key,player_id,action,instance_id
         ) VALUES ($1,$2,'ground_drop',$3)`,
        [operationKey, playerId, input.equipmentInstanceId]
      );
      const createdAt = this.now();
      const expiresAt = MANOR_PERSISTENT_DROP_EXPIRES_AT;
      const regionCode = `interior:manor:${input.manorId}`;
      const zoneId = `manor:${input.manorId}:${input.spaceId}`;
      const inserted = await client.query<EquipmentDropRow>(
        `INSERT INTO world_equipment_drops (
           id,operation_key,equipment_instance_id,item_id,dropped_by,
           region_code,zone_id,pile_id,pile_order,status,lat,lon,geom,
           created_at,expires_at,manor_id,space_id,local_x,local_y
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,0,'active',0,0,
           ST_SetSRID(ST_MakePoint(0,0),4326),$9,$10,$11::uuid,$12,$13,$14
         )
         RETURNING ${EQUIPMENT_DROP_COLUMNS}`,
        [
          dropId,
          operationKey,
          input.equipmentInstanceId,
          instance.definition_id,
          playerId,
          regionCode,
          zoneId,
          `manor:${input.manorId}:${input.spaceId}`,
          createdAt,
          expiresAt,
          input.manorId,
          input.spaceId,
          input.position.x,
          input.position.y
        ]
      );
      const moved = await client.query(
        `UPDATE equipment_instances
         SET location='world_drop',inventory_slot_index=NULL
         WHERE instance_id=$1 AND owner_player_id=$2 AND location='inventory'`,
        [input.equipmentInstanceId, playerId]
      );
      if (moved.rowCount !== 1) {
        throw new DroppedItemError(
          "DROP_EQUIPMENT_STALE",
          "Equipment location changed before the drop committed"
        );
      }
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+1
         WHERE player_id=$1`,
        [playerId]
      );
      await client.query(
        `UPDATE equipment_operations
         SET result=$2::jsonb,completed_at=$3
         WHERE operation_key=$1`,
        [operationKey, JSON.stringify({ dropId }), createdAt]
      );
      const drop = equipmentRowToSnapshot(requireEquipmentDropRow(inserted.rows[0]));
      await client.query("COMMIT");
      return { drop, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDropError(error);
    } finally {
      client.release();
    }
  }

  async pickupDroppedEquipment(
    player: DroppedItemActor,
    requestId: string,
    dropId: string
  ): Promise<DroppedEquipmentResult> {
    const operationKey = requestOperationKey(
      "equipment-pickup",
      player.playerId,
      requestId
    );
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const row = await lockEquipmentDrop(client, dropId);
      const replay = await replayEquipmentPickup(
        client,
        operationKey,
        player.playerId,
        row
      );
      if (replay) {
        await client.query("COMMIT");
        committed = true;
        return replay;
      }
      if (row.status === "picked_up") {
        throw new DroppedItemError(
          "DROPPED_ITEM_ALREADY_PICKED_UP",
          "Dropped equipment has already been picked up"
        );
      }
      if (row.status !== "active") {
        throw new DroppedItemError(
          row.status === "expired" ? "DROPPED_ITEM_EXPIRED" : "DROPPED_ITEM_NOT_ACTIVE",
          row.status === "expired" ? "Dropped equipment has expired" : "Dropped equipment is not active"
        );
      }
      assertDropLocationAndRange(player, row);
      const now = this.now();
      if (!row.manor_id && now.getTime() >= dateMs(row.expires_at)) {
        await expireLockedEquipmentDrop(client, row, now);
        await client.query("COMMIT");
        committed = true;
        throw new DroppedItemError("DROPPED_ITEM_EXPIRED", "Dropped equipment has expired");
      }
      // A Rough ring on the ground (full-bag loot) stays bound: only its owner may take it.
      const bound = await client.query<{ bound: boolean }>(
        `SELECT (ring_rough AND owner_player_id<>$2) AS bound FROM equipment_instances WHERE instance_id=$1`,
        [row.equipment_instance_id, player.playerId]
      );
      if (bound.rows[0]?.bound) {
        throw new DroppedItemError("DROPPED_ITEM_NOT_ACTIVE", "This ring is not yours to pick up");
      }
      await ensureEquipmentInventoryScaffold(client, player.playerId);
      await assertInventoryWeightInTransaction(client, player.playerId, BigInt(requireRuntimeItemDefinition(row.item_id).unitWeightGrams));
      await client.query(
        `INSERT INTO equipment_operations (
           operation_key,player_id,action,instance_id
         ) VALUES ($1,$2,'ground_pickup',$3)`,
        [operationKey, player.playerId, row.equipment_instance_id]
      );
      const moved = await client.query(
        `UPDATE equipment_instances
         SET owner_player_id=$2,location='inventory',inventory_slot_index=$3
         WHERE instance_id=$1 AND location='world_drop'
           AND (NOT ring_rough OR owner_player_id=$2)`,
        [row.equipment_instance_id, player.playerId, null]
      );
      if (moved.rowCount !== 1) {
        throw new DroppedItemError(
          "DROPPED_ITEM_ALREADY_PICKED_UP",
          "Dropped equipment changed before pickup committed"
        );
      }
      const updated = await client.query<EquipmentDropRow>(
        `UPDATE world_equipment_drops
         SET status='picked_up',pickup_operation_key=$2,picked_up_by=$3,picked_up_at=$4
         WHERE id=$1 AND status='active'
         RETURNING ${EQUIPMENT_DROP_COLUMNS}`,
        [row.id, operationKey, player.playerId, now]
      );
      const resultingDrop = requireEquipmentDropRow(updated.rows[0]);
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+1
         WHERE player_id=$1`,
        [player.playerId]
      );
      await client.query(
        `UPDATE equipment_operations
         SET result=$2::jsonb,completed_at=$3
         WHERE operation_key=$1`,
        [operationKey, JSON.stringify({ dropId: row.id }), now]
      );
      await client.query("COMMIT");
      committed = true;
      return { drop: equipmentRowToSnapshot(resultingDrop), replayed: false };
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw mapDropError(error, "pickup");
    } finally {
      client.release();
    }
  }

  async pickupDroppedBackpack(
    player: DroppedItemActor,
    requestId: string,
    dropId: string
  ): Promise<DroppedBackpackResult> {
    const operationKey = requestOperationKey(
      "backpack-pickup",
      player.playerId,
      requestId
    );
    const requestHash = createHash("sha256")
      .update(`${player.playerId}\u0000${dropId}`)
      .digest("hex");
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const row = await lockBackpackDrop(client, dropId);
      const replay = await replayBackpackPickup(
        client,
        operationKey,
        player.playerId,
        dropId,
        requestHash
      );
      if (replay) {
        await client.query("COMMIT");
        committed = true;
        return replay;
      }
      if (row.status === "picked_up") {
        throw new DroppedItemError(
          "DROPPED_ITEM_ALREADY_PICKED_UP",
          "Dropped backpack has already been picked up"
        );
      }
      if (row.status !== "active") {
        throw new DroppedItemError(
          "DROPPED_ITEM_NOT_ACTIVE",
          "Dropped backpack is not active"
        );
      }
      if (row.manor_id && row.dropped_by !== player.playerId) {
        throw new DroppedItemError(
          "DROPPED_ITEM_OUT_OF_RANGE",
          "Only the Manor owner may pick up this backpack"
        );
      }
      assertDropLocationAndRange(player, row);
      const now = this.now();
      if (now.getTime() >= dateMs(row.expires_at)) {
        throw new DroppedItemError("DROPPED_ITEM_EXPIRED", "Dropped backpack has expired");
      }
      await lockInventoryCapacity(client, player.playerId);
      try {
        await assertInventoryWeightInTransaction(
          client,
          player.playerId,
          BigInt(getBackpackWeightGrams())
        );
      } catch (error) {
        if (isInventoryCapacityError(error)) {
          throw new DroppedItemError(
            "DROPPED_BACKPACK_CARRY_CAPACITY_EXCEEDED",
            "Carrying capacity is full; the backpack remains on the floor"
          );
        }
        throw error;
      }
      await client.query(
        `INSERT INTO player_backpack_state (player_id)
         SELECT id FROM players WHERE id=$1
         ON CONFLICT (player_id) DO NOTHING`,
        [player.playerId]
      );
      await client.query(
        `SELECT revision FROM player_backpack_state WHERE player_id=$1 FOR UPDATE`,
        [player.playerId]
      );
      const operation = await client.query(
        `INSERT INTO backpack_drop_operations (
           operation_key,player_id,request_id,action,request_hash,instance_id,drop_id
         ) VALUES ($1,$2,$3,'pickup',$4,$5::uuid,$6::uuid)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [
          operationKey,
          player.playerId,
          requestId,
          requestHash,
          row.backpack_instance_id,
          row.id
        ]
      );
      if (operation.rowCount !== 1) {
        const concurrentReplay = await replayBackpackPickup(
          client,
          operationKey,
          player.playerId,
          dropId,
          requestHash
        );
        if (!concurrentReplay) {
          throw new DroppedItemError(
            "DROPPED_BACKPACK_PICKUP_REPLAY_CONFLICT",
            "Backpack pickup has incomplete durable state"
          );
        }
        await client.query("COMMIT");
        committed = true;
        return concurrentReplay;
      }
      const moved = await client.query(
        `UPDATE player_backpack_instances
         SET owner_player_id=$2, location='inventory', equipped_slot=NULL,
             inventory_slot_index=NULL, manor_id=NULL, manor_slot_index=NULL,
             version=version+1, updated_at=now()
         WHERE instance_id=$1 AND owner_player_id=$3 AND location='world_drop'`,
        [row.backpack_instance_id, player.playerId, row.owner_player_id]
      );
      if (moved.rowCount !== 1) {
        throw new DroppedItemError(
          "DROPPED_ITEM_ALREADY_PICKED_UP",
          "Backpack changed before pickup committed"
        );
      }
      await client.query(
        `UPDATE player_backpack_state
         SET revision=revision+1,updated_at=now()
         WHERE player_id=$1`,
        [player.playerId]
      );
      const updated = await client.query<{ id: string }>(
        `UPDATE world_backpack_drops
         SET status='picked_up',pickup_operation_key=$2,picked_up_by=$3,picked_up_at=$4
         WHERE id=$1 AND status='active'
         RETURNING id`,
        [row.id, operationKey, player.playerId, now]
      );
      const updatedDropId = updated.rows[0]?.id;
      if (updated.rowCount !== 1 || !updatedDropId) {
        throw new DroppedItemError(
          "DROPPED_ITEM_ALREADY_PICKED_UP",
          "Dropped backpack changed before pickup committed"
        );
      }
      const resultingDrop = await lockBackpackDrop(client, updatedDropId);
      const backpacks = await backpackSnapshotInTransaction(client, player.playerId);
      const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      const drop = backpackRowToSnapshot(resultingDrop);
      await client.query(
        `UPDATE backpack_drop_operations
         SET original_result=$2::jsonb,completed_at=$3
         WHERE operation_key=$1`,
        [operationKey, JSON.stringify({ drop, backpacks, inventory }), now]
      );
      await client.query("COMMIT");
      committed = true;
      return { drop, backpacks, inventory, replayed: false };
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw mapDropError(error, "pickup");
    } finally {
      client.release();
    }
  }

  async pickupDroppedItem(
    player: DroppedItemActor,
    requestId: string,
    dropId: string,
    pickup: DroppedItemPickupIntent = { mode: "all" }
  ): Promise<DroppedItemPickupResult> {
    const intent = normalizePickupIntent(pickup);
    const operationKey = requestOperationKey("pickup", player.playerId, requestId);
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const row = await lockDrop(client, dropId);
      const replay = await findPickupByOperationKey(client, operationKey);
      if (replay) {
        assertMatchingPickup(replay, player.playerId, dropId, intent);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        committed = true;
        return {
          drop: rowToSnapshot(row),
          inventory,
          replayed: true,
          requestedQuantity: replay.pickup_mode === "quantity"
            ? inventoryQuantityToSafeNumber(replay.requested_quantity!)
            : inventoryQuantityToSafeNumber(replay.granted_quantity) +
              inventoryQuantityToSafeNumber(replay.remaining_quantity),
          pickedUpQuantity: inventoryQuantityToSafeNumber(replay.granted_quantity),
          remainingQuantity: row.status === "active"
            ? inventoryQuantityToSafeNumber(row.remaining_quantity)
            : 0,
          removed: row.status !== "active"
        };
      }
      if (row.status === "picked_up") {
        throw new DroppedItemError(
          "DROPPED_ITEM_ALREADY_PICKED_UP",
          "Dropped item has already been picked up"
        );
      }
      if (row.status !== "active") {
        throw new DroppedItemError(
          row.status === "expired" ? "DROPPED_ITEM_EXPIRED" : "DROPPED_ITEM_NOT_ACTIVE",
          row.status === "expired" ? "Dropped item has expired" : "Dropped item is not active"
        );
      }
      assertDropLocationAndRange(player, row);

      const now = this.now();
      if (!row.manor_id && now.getTime() >= dateMs(row.expires_at)) {
        await expireLockedDrop(client, row, now);
        await client.query("COMMIT");
        committed = true;
        throw new DroppedItemError("DROPPED_ITEM_EXPIRED", "Dropped item has expired");
      }
      const availableQuantity = inventoryQuantityToSafeNumber(row.remaining_quantity);
      const grantedQuantity = intent.mode === "all" ? availableQuantity : intent.quantity;
      if (grantedQuantity > availableQuantity) {
        throw new DroppedItemError(
          "DROPPED_ITEM_QUANTITY_UNAVAILABLE",
          `Only ${availableQuantity} item${availableQuantity === 1 ? " is" : "s are"} still available`,
          { dropId: row.id, remainingQuantity: availableQuantity }
        );
      }
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey,
        playerId: player.playerId,
        source: "pickup_dropped_item",
        sourceEntityType: "world_item_drop",
        sourceEntityId: row.id,
        metadata: { requestId, pickup: intent, requestedQuantity: grantedQuantity },
        allowPartial: true,
        grants: [
          {
            itemId: row.item_id as ResourceType,
            variant: snapshotVariant(row.variant),
            quantity: grantedQuantity
          }
        ]
      });
      if (!grant.applied) {
        throw new DroppedItemError(
          "DROPPED_ITEM_PICKUP_REPLAY_CONFLICT",
          "Pickup request was already used for another operation"
        );
      }
      const grantedResult = grant.grants[0];
      const acceptedQuantity = grantedResult?.grantedQuantity ?? 0;
      if (acceptedQuantity <= 0) {
        throw new DroppedItemError(
          "DROPPED_ITEM_QUANTITY_UNAVAILABLE",
          "Carrying capacity is full; no part of this item can be picked up",
          { dropId: row.id, remainingQuantity: availableQuantity }
        );
      }
      const remainingQuantity = availableQuantity - acceptedQuantity;

      const updated = remainingQuantity === 0
        ? await client.query<DroppedItemRow>(
            `
            UPDATE world_item_drops
            SET status = 'picked_up',
                remaining_quantity = 0,
                pickup_operation_key = $2,
                picked_up_by = $3,
                picked_up_at = $4
            WHERE id = $1
              AND status = 'active'
            RETURNING ${DROP_COLUMNS}
            `,
            [row.id, operationKey, player.playerId, now]
          )
        : await client.query<DroppedItemRow>(
            `
            UPDATE world_item_drops
            SET remaining_quantity = $2::bigint
            WHERE id = $1
              AND status = 'active'
              AND remaining_quantity >= $3::bigint
            RETURNING ${DROP_COLUMNS}
            `,
            [row.id, remainingQuantity, acceptedQuantity]
          );
      const resultingDrop = requireDropRow(updated.rows[0]);
      await client.query(
        `
        INSERT INTO world_item_pickups (
          operation_key, drop_id, player_id, pickup_mode, requested_quantity,
          granted_quantity, remaining_quantity, resulting_status, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          operationKey,
          row.id,
          player.playerId,
          intent.mode,
          intent.mode === "quantity" ? intent.quantity : null,
          acceptedQuantity,
          remainingQuantity,
          remainingQuantity === 0 ? "picked_up" : "active",
          now
        ]
      );
      await client.query(
        `INSERT INTO world_item_movements (
           drop_id, movement_kind, operation_key, pickup_operation_key, player_id,
           item_id, variant, quantity, reason, created_at
         ) VALUES (
           $1,'world_to_player',$2,$2,$3,$4,$5,$6::bigint,'drop_picked_up',$7
         )`,
        [
          row.id,
          operationKey,
          player.playerId,
          row.item_id,
          row.variant,
          acceptedQuantity,
          now
        ]
      );
      await client.query("COMMIT");
      committed = true;
      return {
        drop: rowToSnapshot(resultingDrop),
        inventory: grant.inventory,
        replayed: false,
        requestedQuantity: intent.mode === "all" ? availableQuantity : intent.quantity,
        pickedUpQuantity: acceptedQuantity,
        remainingQuantity,
        removed: remainingQuantity === 0
      };
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK");
      }
      throw mapDropError(error, "pickup");
    } finally {
      client.release();
    }
  }

  /** `viewerPlayerId` sees their own Rough ring drops; everyone else never does. */
  async listActive(regionCode: string, viewerPlayerId: string | null = null): Promise<DroppedItemSnapshot[]> {
    const now = this.now();
    await this.expireDue(now);
    const [result, equipmentResult, backpackResult] = await Promise.all([
      this.pool.query<DroppedItemRow>(
      `
      SELECT ${DROP_COLUMNS}
      FROM world_item_drops
      WHERE region_code = $1
        AND manor_id IS NULL
        AND status = 'active'
        AND expires_at > $2
      ORDER BY created_at ASC, id ASC
      `,
      [regionCode, now]
      ),
      this.pool.query<EquipmentDropRow>(
        `SELECT ${EQUIPMENT_DROP_COLUMNS}
         FROM world_equipment_drops
         WHERE manor_id IS NULL
           AND region_code=$1 AND status='active' AND expires_at>$2
           AND ${roughRingDropVisibleSql("$3")}
         ORDER BY created_at,id`,
        [regionCode, now, viewerPlayerId]
      ),
      this.pool.query<BackpackDropRow>(
        `SELECT ${BACKPACK_DROP_COLUMNS}
         FROM world_backpack_drops drop_row
         JOIN player_backpack_instances backpack
           ON backpack.instance_id=drop_row.backpack_instance_id
         WHERE drop_row.manor_id IS NULL
           AND drop_row.region_code=$1 AND drop_row.status='active' AND drop_row.expires_at>$2
         ORDER BY drop_row.created_at,drop_row.id`,
        [regionCode, now]
      )
    ]);
    return sortDropSnapshots([
      ...result.rows.map(rowToSnapshot),
      ...equipmentResult.rows.map(equipmentRowToSnapshot),
      ...backpackResult.rows.map(backpackRowToSnapshot)
    ]);
  }

  async listActiveInGameplayCircle(
    center: LatLon,
    radiusM: number,
    eligibleRegionCodes: readonly string[] = [],
    eligibleZoneIds: readonly string[] = [],
    viewerPlayerId: string | null = null
  ): Promise<DroppedItemSnapshot[]> {
    const now = this.now();
    await this.expireDue(now);
    const [result, equipmentResult, backpackResult] = await Promise.all([
      this.pool.query<DroppedItemRow>(
      `
      SELECT ${DROP_COLUMNS}
      FROM world_item_drops
      WHERE status = 'active'
        AND manor_id IS NULL
        AND expires_at > $3
        AND (cardinality($5::text[]) = 0 OR region_code = ANY($5::text[]))
        AND (cardinality($6::text[]) = 0 OR zone_id = ANY($6::text[]))
        AND ST_DWithin(
          geom::geography,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $4
        )
      ORDER BY created_at ASC, id ASC
      `,
      [center.lat, center.lon, now, radiusM, eligibleRegionCodes, eligibleZoneIds]
      ),
      this.pool.query<EquipmentDropRow>(
        `SELECT ${EQUIPMENT_DROP_COLUMNS}
         FROM world_equipment_drops
         WHERE manor_id IS NULL
           AND status='active'
           AND expires_at>$3
           AND (cardinality($5::text[])=0 OR region_code=ANY($5::text[]))
           AND (cardinality($6::text[])=0 OR zone_id=ANY($6::text[]))
           AND ST_DWithin(
             geom::geography,
             ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
             $4
           )
           AND ${roughRingDropVisibleSql("$7")}
         ORDER BY created_at,id`,
        [center.lat, center.lon, now, radiusM, eligibleRegionCodes, eligibleZoneIds, viewerPlayerId]
      ),
      this.pool.query<BackpackDropRow>(
        `SELECT ${BACKPACK_DROP_COLUMNS}
         FROM world_backpack_drops drop_row
         JOIN player_backpack_instances backpack
           ON backpack.instance_id=drop_row.backpack_instance_id
         WHERE drop_row.manor_id IS NULL
           AND drop_row.status='active'
           AND drop_row.expires_at>$3
           AND (cardinality($5::text[])=0 OR drop_row.region_code=ANY($5::text[]))
           AND (cardinality($6::text[])=0 OR drop_row.zone_id=ANY($6::text[]))
           AND ST_DWithin(
             drop_row.geom::geography,
             ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
             $4
           )
         ORDER BY drop_row.created_at,drop_row.id`,
        [center.lat, center.lon, now, radiusM, eligibleRegionCodes, eligibleZoneIds]
      )
    ]);
    return sortDropSnapshots([
      ...result.rows.map(rowToSnapshot),
      ...equipmentResult.rows.map(equipmentRowToSnapshot),
      ...backpackResult.rows.map(backpackRowToSnapshot)
    ]);
  }

  async listActiveManorEquipment(
    manorId: string,
    spaceId?: ManorSpaceId
  ): Promise<DroppedItemSnapshot[]> {
    const now = this.now();
    await this.expireDue(now);
    const result = await this.pool.query<EquipmentDropRow>(
      `SELECT ${EQUIPMENT_DROP_COLUMNS}
       FROM world_equipment_drops
       WHERE manor_id=$1::uuid
         AND status='active'
         AND ($2::text IS NULL OR space_id=$2)
       ORDER BY created_at,id`,
      [manorId, spaceId ?? null]
    );
    return sortDropSnapshots(result.rows.map(equipmentRowToSnapshot));
  }

  async listActiveManorDrops(
    manorId: string,
    spaceId?: ManorSpaceId
  ): Promise<DroppedItemSnapshot[]> {
    const [items, equipment, backpacks] = await Promise.all([
      this.pool.query<DroppedItemRow>(
        `SELECT ${DROP_COLUMNS}
         FROM world_item_drops
         WHERE manor_id=$1::uuid
           AND status='active'
           AND ($2::text IS NULL OR space_id=$2)
         ORDER BY created_at,id`,
        [manorId, spaceId ?? null]
      ),
      this.pool.query<EquipmentDropRow>(
        `SELECT ${EQUIPMENT_DROP_COLUMNS}
         FROM world_equipment_drops
         WHERE manor_id=$1::uuid
           AND status='active'
           AND ($2::text IS NULL OR space_id=$2)
         ORDER BY created_at,id`,
        [manorId, spaceId ?? null]
      ),
      this.pool.query<BackpackDropRow>(
        `SELECT ${BACKPACK_DROP_COLUMNS}
         FROM world_backpack_drops drop_row
         JOIN player_backpack_instances backpack
           ON backpack.instance_id=drop_row.backpack_instance_id
         WHERE drop_row.manor_id=$1::uuid
           AND drop_row.status='active'
           AND ($2::text IS NULL OR drop_row.space_id=$2)
         ORDER BY drop_row.created_at,drop_row.id`,
        [manorId, spaceId ?? null]
      )
    ]);
    return sortDropSnapshots([
      ...items.rows.map(rowToSnapshot),
      ...equipment.rows.map(equipmentRowToSnapshot),
      ...backpacks.rows.map(backpackRowToSnapshot)
    ]);
  }

  async expireDue(now = this.now(), limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Dropped item expiry limit must be between 1 and 10000");
    }
    const result = await this.pool.query<{ expired_count: string }>(
      `WITH due AS MATERIALIZED (
         SELECT id, item_id, variant, remaining_quantity
         FROM world_item_drops
         WHERE status = 'active' AND manor_id IS NULL AND expires_at <= $1
         ORDER BY expires_at ASC, id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       ), expired AS (
         UPDATE world_item_drops drop_row
         SET status = 'expired', remaining_quantity = 0, expired_at = $1
         FROM due
         WHERE drop_row.id = due.id AND drop_row.status = 'active'
         RETURNING drop_row.id, due.item_id, due.variant, due.remaining_quantity
       ), movements AS (
         INSERT INTO world_item_movements (
           drop_id, movement_kind, item_id, variant, quantity, reason, created_at
         )
         SELECT id, 'world_to_destruction', item_id, variant, remaining_quantity,
                'expired_sink', $1
         FROM expired
         ON CONFLICT DO NOTHING
         RETURNING drop_id
       )
       SELECT count(*)::text AS expired_count FROM movements`,
      [now, limit]
    );
    const equipmentResult = await this.pool.query<{ expired_count: string }>(
      `WITH due AS MATERIALIZED (
         SELECT drop.id,drop.equipment_instance_id,drop.dropped_by
         FROM world_equipment_drops drop
         JOIN equipment_instances instance
           ON instance.instance_id=drop.equipment_instance_id
          AND instance.location='world_drop'
         WHERE drop.status='active' AND drop.manor_id IS NULL AND drop.expires_at<=$1
         ORDER BY drop.expires_at,drop.id
         LIMIT $2
         FOR UPDATE OF drop,instance SKIP LOCKED
       ), operations AS (
         INSERT INTO equipment_operations (
           operation_key,player_id,action,instance_id,result,completed_at
         )
         SELECT 'ground-expire:' || id::text,dropped_by,'ground_expire',
                equipment_instance_id,jsonb_build_object('dropId',id),$1
         FROM due
         ON CONFLICT (operation_key) DO NOTHING
       ), moved AS (
         UPDATE equipment_instances instance
         SET location='destroyed'
         FROM due
         WHERE instance.instance_id=due.equipment_instance_id
           AND instance.location='world_drop'
         RETURNING due.id
       ), expired AS (
         UPDATE world_equipment_drops drop
         SET status='expired',expired_at=$1
         FROM moved
         WHERE drop.id=moved.id AND drop.status='active'
         RETURNING drop.id
       )
       SELECT count(*)::text AS expired_count FROM expired`,
      [now, limit]
    );
    // Overworld backpacks (death drops) despawn like equipment: the instance is destroyed.
    const backpackResult = await this.pool.query<{ expired_count: string }>(
      `WITH due AS MATERIALIZED (
         SELECT drop_row.id,drop_row.backpack_instance_id
         FROM world_backpack_drops drop_row
         JOIN player_backpack_instances backpack
           ON backpack.instance_id=drop_row.backpack_instance_id
          AND backpack.location='world_drop'
         WHERE drop_row.status='active' AND drop_row.manor_id IS NULL AND drop_row.expires_at<=$1
         ORDER BY drop_row.expires_at,drop_row.id
         LIMIT $2
         FOR UPDATE OF drop_row,backpack SKIP LOCKED
       ), moved AS (
         UPDATE player_backpack_instances backpack
         SET location='destroyed',version=backpack.version+1,updated_at=$1
         FROM due
         WHERE backpack.instance_id=due.backpack_instance_id
           AND backpack.location='world_drop'
         RETURNING due.id
       ), expired AS (
         UPDATE world_backpack_drops drop_row
         SET status='expired',expired_at=$1
         FROM moved
         WHERE drop_row.id=moved.id AND drop_row.status='active'
         RETURNING drop_row.id
       )
       SELECT count(*)::text AS expired_count FROM expired`,
      [now, limit]
    );
    return Number(result.rows[0]?.expired_count ?? "0") +
      Number(equipmentResult.rows[0]?.expired_count ?? "0") +
      Number(backpackResult.rows[0]?.expired_count ?? "0");
  }
}

const DROP_COLUMNS = `
  id, operation_key, dropped_by, region_code, zone_id, pile_id, pile_order,
  item_id, variant,
  original_quantity::text, remaining_quantity::text,
  status, lat, lon, created_at, expires_at, expired_at, pickup_operation_key,
  picked_up_by, picked_up_at, manor_id::text, space_id, local_x, local_y
`;

const EQUIPMENT_DROP_COLUMNS = `
  id,operation_key,equipment_instance_id::text,item_id,dropped_by,
  region_code,zone_id,pile_id,pile_order,status,lat,lon,
  created_at,expires_at,expired_at,pickup_operation_key,
  picked_up_by,picked_up_at,manor_id::text,space_id,local_x,local_y
`;

const BACKPACK_DROP_COLUMNS = `
  drop_row.id,drop_row.operation_key,drop_row.backpack_instance_id::text,
  drop_row.dropped_by,drop_row.region_code,drop_row.zone_id,drop_row.pile_id,
  drop_row.pile_order,drop_row.status,drop_row.lat,drop_row.lon,
  drop_row.created_at,drop_row.expires_at,drop_row.pickup_operation_key,
  drop_row.picked_up_by,drop_row.picked_up_at,drop_row.manor_id::text,
  drop_row.space_id,drop_row.local_x,drop_row.local_y,
  backpack.owner_player_id,backpack.definition_id,backpack.upgrade_level,
  backpack.location AS backpack_location,backpack.equipped_slot,
  backpack.inventory_slot_index,backpack.manor_id::text AS backpack_manor_id,
  backpack.manor_slot_index,backpack.version::text AS backpack_version,
  backpack.created_at AS backpack_created_at,backpack.updated_at AS backpack_updated_at
`;

/**
 * An owned backpack still belongs in its owner's snapshot unless it lies on
 * the overworld ground (a death drop): those give no capacity, matching
 * player_inventory_maximum_grams, and anyone may pick them up.
 */
export function ownedBackpackVisibleSql(alias: string): string {
  return `(${alias}.location<>'world_drop' OR EXISTS (
    SELECT 1 FROM world_backpack_drops owned_drop
    WHERE owned_drop.backpack_instance_id=${alias}.instance_id
      AND owned_drop.manor_id IS NOT NULL AND owned_drop.status='active'
  ))`;
}

/** A Rough ring lying on the ground (full-bag loot) is listed only to the player it dropped for. */
function roughRingDropVisibleSql(viewerParameter: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM equipment_instances rough_ring
    WHERE rough_ring.instance_id=world_equipment_drops.equipment_instance_id
      AND rough_ring.ring_rough
      AND rough_ring.owner_player_id IS DISTINCT FROM ${viewerParameter}::text
  )`;
}

export type GroundPlacement = Readonly<{
  regionCode: string;
  zoneId: string;
  pileId: string;
  pileOrder: number;
  position: LatLon;
  createdAt: Date;
}>;

/**
 * Moves one owned, carried (inventory or equipped) backpack onto the
 * overworld ground. The caller holds the owner's carry lock and owns the
 * transaction; the operation key must be unique per drop.
 */
export async function dropBackpackToGroundInTransaction(
  client: Queryable,
  input: Readonly<{
    operationKey: string;
    requestId: string;
    playerId: string;
    instanceId: string;
    placement: GroundPlacement;
  }>
): Promise<DroppedBackpackResult["drop"]> {
  const dropId = dropIdForOperation(input.operationKey);
  const { placement } = input;
  const expiresAt = new Date(placement.createdAt.getTime() + DROPPED_ITEM_TTL_MS);
  await client.query(
    `INSERT INTO player_backpack_state (player_id) VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
    [input.playerId]
  );
  await client.query(
    `INSERT INTO backpack_drop_operations (
       operation_key,player_id,request_id,action,request_hash,instance_id,drop_id,
       original_result,created_at,completed_at
     ) VALUES ($1,$2,$3,'death_drop',$4,$5::uuid,$6::uuid,$7::jsonb,$8,$8)`,
    [
      input.operationKey,
      input.playerId,
      input.requestId,
      createHash("sha256").update(input.operationKey).digest("hex"),
      input.instanceId,
      dropId,
      JSON.stringify({ dropId, backpackInstanceId: input.instanceId }),
      placement.createdAt
    ]
  );
  await client.query(
    `INSERT INTO world_backpack_drops (
       id,operation_key,backpack_instance_id,dropped_by,region_code,zone_id,pile_id,pile_order,
       status,lat,lon,geom,created_at,expires_at
     ) VALUES (
       $1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,'active',$9,$10,
       ST_SetSRID(ST_MakePoint($10,$9),4326),$11,$12
     )`,
    [
      dropId, input.operationKey, input.instanceId, input.playerId,
      placement.regionCode, placement.zoneId, placement.pileId, placement.pileOrder,
      placement.position.lat, placement.position.lon, placement.createdAt, expiresAt
    ]
  );
  const moved = await client.query(
    `UPDATE player_backpack_instances
     SET location='world_drop',equipped_slot=NULL,inventory_slot_index=NULL,
         version=version+1,updated_at=$3
     WHERE instance_id=$1::uuid AND owner_player_id=$2 AND location IN ('inventory','equipped')`,
    [input.instanceId, input.playerId, placement.createdAt]
  );
  if (moved.rowCount !== 1) throw new Error("Backpack left the carry before the ground drop committed");
  await client.query(
    "UPDATE player_backpack_state SET revision=revision+1,updated_at=now() WHERE player_id=$1",
    [input.playerId]
  );
  return backpackRowToSnapshot(await lockBackpackDrop(client, dropId));
}

/**
 * Moves one owned, unequipped equipment instance onto the overworld ground,
 * with the same custody evidence as a player's own equipment drop.
 */
export async function dropEquipmentToGroundInTransaction(
  client: Queryable,
  input: Readonly<{
    operationKey: string;
    playerId: string;
    instanceId: string;
    itemId: EquipmentDefinitionId;
    placement: GroundPlacement;
  }>
): Promise<DroppedEquipmentResult["drop"]> {
  const dropId = dropIdForOperation(input.operationKey);
  const { placement } = input;
  const expiresAt = new Date(placement.createdAt.getTime() + DROPPED_ITEM_TTL_MS);
  await client.query(
    `INSERT INTO equipment_operations (operation_key,player_id,action,instance_id)
     VALUES ($1,$2,'ground_drop',$3)`,
    [input.operationKey, input.playerId, input.instanceId]
  );
  const inserted = await client.query<EquipmentDropRow>(
    `INSERT INTO world_equipment_drops (
       id,operation_key,equipment_instance_id,item_id,dropped_by,
       region_code,zone_id,pile_id,pile_order,status,lat,lon,geom,
       created_at,expires_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,
       ST_SetSRID(ST_MakePoint($11,$10),4326),$12,$13
     )
     RETURNING ${EQUIPMENT_DROP_COLUMNS}`,
    [
      dropId, input.operationKey, input.instanceId, input.itemId, input.playerId,
      placement.regionCode, placement.zoneId, placement.pileId, placement.pileOrder,
      placement.position.lat, placement.position.lon, placement.createdAt, expiresAt
    ]
  );
  const moved = await client.query(
    `UPDATE equipment_instances
     SET location='world_drop',inventory_slot_index=NULL
     WHERE instance_id=$1 AND owner_player_id=$2 AND location='inventory'`,
    [input.instanceId, input.playerId]
  );
  if (moved.rowCount !== 1) throw new Error("Equipment left the inventory before the ground drop committed");
  await client.query(
    "UPDATE player_equipment_state SET inventory_revision=inventory_revision+1 WHERE player_id=$1",
    [input.playerId]
  );
  await client.query(
    "UPDATE equipment_operations SET result=$2::jsonb,completed_at=$3 WHERE operation_key=$1",
    [input.operationKey, JSON.stringify({ dropId }), placement.createdAt]
  );
  return equipmentRowToSnapshot(requireEquipmentDropRow(inserted.rows[0]));
}

async function replaySystemGroundDropContribution(
  queryable: Queryable,
  operationKey: string
): Promise<Readonly<{
  drop: DroppedItemSnapshot;
  contributedQuantity: number;
}> | null> {
  const source = await queryable.query<{ drop_id: string }>(
    `SELECT drop_id
     FROM world_item_system_drop_sources
     WHERE operation_key = $1`,
    [operationKey]
  );
  const dropId = source.rows[0]?.drop_id;
  if (!dropId) return null;
  const drop = await queryable.query<DroppedItemRow>(
    `SELECT ${DROP_COLUMNS} FROM world_item_drops WHERE id = $1`,
    [dropId]
  );
  const movement = await queryable.query<{ quantity: string }>(
    `SELECT quantity::text
     FROM world_item_movements
     WHERE drop_id = $1
       AND movement_kind = 'system_to_world'
       AND operation_key = $2`,
    [dropId, operationKey]
  );
  const contributedQuantity = movement.rows[0]?.quantity;
  if (!contributedQuantity) {
    throw new Error("System ground-drop source lacks its custody movement");
  }
  return {
    drop: rowToSnapshot(requireDropRow(drop.rows[0])),
    contributedQuantity: inventoryQuantityToSafeNumber(contributedQuantity)
  };
}

async function replayDropRequest(
  queryable: Queryable,
  inventory: InventoryGateway,
  operationKey: string,
  playerId: string,
  requestHash: string
): Promise<DroppedItemResult | null> {
  const result = await queryable.query<DropRequestRow>(
    `SELECT request_hash, original_result
     FROM world_item_drop_requests
     WHERE operation_key = $1 AND player_id = $2`,
    [operationKey, playerId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash || !row.original_result.drop) {
    throw new DroppedItemError(
      "DROP_REPLAY_CONFLICT",
      "Drop request id was reused with different item details"
    );
  }
  return {
    drop: row.original_result.drop,
    inventory: row.original_result.inventory ??
      await inventory.snapshotInTransaction(queryable, playerId),
    replayed: true
  };
}

async function findPickupByOperationKey(
  queryable: Queryable,
  operationKey: string
): Promise<DroppedItemPickupRow | null> {
  const result = await queryable.query<DroppedItemPickupRow>(
    `
    SELECT operation_key, drop_id, player_id, pickup_mode, requested_quantity,
           granted_quantity, remaining_quantity, resulting_status
    FROM world_item_pickups
    WHERE operation_key = $1
    `,
    [operationKey]
  );
  return result.rows[0] ?? null;
}

async function lockDrop(queryable: Queryable, dropId: string): Promise<DroppedItemRow> {
  const result = await queryable.query<DroppedItemRow>(
    `SELECT ${DROP_COLUMNS} FROM world_item_drops WHERE id = $1 FOR UPDATE`,
    [dropId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new DroppedItemError("DROPPED_ITEM_NOT_FOUND", "Dropped item does not exist");
  }
  return row;
}

async function expireLockedDrop(
  queryable: Queryable,
  row: DroppedItemRow,
  now: Date
): Promise<void> {
  const remaining = BigInt(row.remaining_quantity);
  if (remaining <= 0n) {
    throw new Error("Active dropped item has no remaining custody quantity");
  }
  const movement = await queryable.query(
    `INSERT INTO world_item_movements (
       drop_id, movement_kind, item_id, variant, quantity, reason, created_at
     ) VALUES ($1,'world_to_destruction',$2,$3,$4::bigint,'expired_sink',$5)
     ON CONFLICT DO NOTHING
     RETURNING movement_id`,
    [row.id, row.item_id, row.variant, remaining.toString(), now]
  );
  if (movement.rowCount !== 1) {
    throw new Error("Dropped item destruction movement already exists for an active drop");
  }
  const expired = await queryable.query(
    `UPDATE world_item_drops
     SET status = 'expired', remaining_quantity = 0, expired_at = $2
     WHERE id = $1 AND status = 'active'
     RETURNING id`,
    [row.id, now]
  );
  if (expired.rowCount !== 1) throw new Error("Dropped item expiry lost its row lock");
}

async function replayEquipmentDrop(
  queryable: Queryable,
  operationKey: string,
  playerId: string,
  equipmentInstanceId: string
): Promise<DroppedEquipmentResult | null> {
  const operation = await groundEquipmentOperation(queryable, operationKey);
  if (!operation) return null;
  if (
    operation.player_id !== playerId ||
    operation.action !== "ground_drop" ||
    operation.instance_id !== equipmentInstanceId
  ) {
    throw new DroppedItemError(
      "DROP_EQUIPMENT_REPLAY_CONFLICT",
      "Equipment drop request ID was reused with different intent"
    );
  }
  if (!operation.completed_at || !operation.result?.dropId) {
    throw new DroppedItemError(
      "DROP_EQUIPMENT_REPLAY_CONFLICT",
      "Equipment drop request has incomplete durable state"
    );
  }
  const result = await queryable.query<EquipmentDropRow>(
    `SELECT ${EQUIPMENT_DROP_COLUMNS}
     FROM world_equipment_drops
     WHERE id=$1 AND operation_key=$2`,
    [operation.result.dropId, operationKey]
  );
  return {
    drop: equipmentRowToSnapshot(requireEquipmentDropRow(result.rows[0])),
    replayed: true
  };
}

async function replayEquipmentPickup(
  queryable: Queryable,
  operationKey: string,
  playerId: string,
  drop: EquipmentDropRow
): Promise<DroppedEquipmentResult | null> {
  const operation = await groundEquipmentOperation(queryable, operationKey);
  if (!operation) return null;
  if (
    operation.player_id !== playerId ||
    operation.action !== "ground_pickup" ||
    operation.instance_id !== drop.equipment_instance_id ||
    operation.result?.dropId !== drop.id ||
    drop.pickup_operation_key !== operationKey ||
    !operation.completed_at
  ) {
    throw new DroppedItemError(
      "DROPPED_EQUIPMENT_PICKUP_REPLAY_CONFLICT",
      "Equipment pickup request ID was reused with different intent"
    );
  }
  return { drop: equipmentRowToSnapshot(drop), replayed: true };
}

async function replayBackpackPickup(
  queryable: Queryable,
  operationKey: string,
  playerId: string,
  dropId: string,
  requestHash: string
): Promise<DroppedBackpackResult | null> {
  const result = await queryable.query<BackpackDropOperationRow>(
    `SELECT player_id,request_id,action,request_hash,instance_id::text,drop_id,
            original_result,completed_at
     FROM backpack_drop_operations
     WHERE operation_key=$1`,
    [operationKey]
  );
  const operation = result.rows[0];
  if (!operation) return null;
  if (
    operation.player_id !== playerId ||
    operation.action !== "pickup" ||
    operation.request_hash !== requestHash ||
    operation.drop_id !== dropId ||
    !operation.completed_at ||
    !operation.original_result?.drop ||
    !operation.original_result.backpacks ||
    !operation.original_result.inventory
  ) {
    throw new DroppedItemError(
      "DROPPED_BACKPACK_PICKUP_REPLAY_CONFLICT",
      "Backpack pickup request ID was reused with different intent"
    );
  }
  return {
    drop: operation.original_result.drop,
    backpacks: operation.original_result.backpacks,
    inventory: operation.original_result.inventory,
    replayed: true
  };
}

async function lockBackpackDrop(
  queryable: Queryable,
  dropId: string
): Promise<BackpackDropRow> {
  const result = await queryable.query<BackpackDropRow>(
    `SELECT ${BACKPACK_DROP_COLUMNS}
     FROM world_backpack_drops drop_row
     JOIN player_backpack_instances backpack
       ON backpack.instance_id=drop_row.backpack_instance_id
     WHERE drop_row.id=$1::uuid
     FOR UPDATE OF drop_row,backpack`,
    [dropId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new DroppedItemError("DROPPED_ITEM_NOT_FOUND", "Dropped backpack does not exist");
  }
  return row;
}

function backpackRowToSnapshot(
  row: BackpackDropRow
): DroppedBackpackResult["drop"] {
  const backpack = mapBackpackDropInstance(row);
  return {
    dropId: row.id,
    droppedBy: row.dropped_by,
    regionCode: row.region_code,
    zoneId: row.zone_id,
    pileId: row.pile_id,
    pileOrder: Number(row.pile_order),
    itemId: row.definition_id,
    backpackInstanceId: row.backpack_instance_id,
    backpack,
    variant: null,
    quantity: row.status === "active" ? 1 : 0,
    maxStack: 1,
    status: row.status,
    lat: storedDropLatitude(row),
    lon: Number(row.lon),
    createdAt: dateIso(row.created_at),
    expiresAt: dateIso(row.expires_at),
    pickedUpBy: row.picked_up_by,
    pickedUpAt: row.picked_up_at === null ? null : dateIso(row.picked_up_at),
    ...(row.manor_id ? { manorId: row.manor_id } : {}),
    ...(row.space_id ? { spaceId: row.space_id } : {}),
    ...(row.local_x !== null ? { localX: Number(row.local_x) } : {}),
    ...(row.local_y !== null ? { localY: Number(row.local_y) } : {})
  };
}

function mapBackpackDropInstance(row: BackpackDropRow): BackpackInstanceSnapshot {
  const definition = requireBackpackDefinition(row.definition_id);
  return {
    instanceId: row.backpack_instance_id,
    ownerPlayerId: row.owner_player_id,
    definitionId: definition.definitionId,
    displayName: `Backpack +${row.upgrade_level}`,
    location: row.backpack_location,
    upgradeLevel: row.upgrade_level,
    capacityBonusGrams: requireBackpackLevel(row.upgrade_level).capacityBonusGrams,
    unitWeightGrams: getBackpackWeightGrams(),
    equippedSlot: row.equipped_slot,
    inventorySlotIndex: row.inventory_slot_index,
    manorId: row.backpack_manor_id,
    manorSlotIndex: row.manor_slot_index,
    version: safeRevision(row.backpack_version),
    createdAt: dateIso(row.backpack_created_at),
    updatedAt: dateIso(row.backpack_updated_at)
  };
}

async function backpackSnapshotInTransaction(
  queryable: Queryable,
  playerId: string
): Promise<BackpackSnapshot> {
  const [state, capacity, rows] = await Promise.all([
    queryable.query<{ revision: string }>(
      "SELECT revision::text FROM player_backpack_state WHERE player_id=$1",
      [playerId]
    ),
    queryable.query<{ base_capacity_grams: string }>(
      "SELECT base_capacity_grams::text FROM player_inventory_capacities WHERE player_id=$1",
      [playerId]
    ),
    queryable.query<BackpackDropRow>(
      `SELECT backpack.instance_id::text AS backpack_instance_id,
              backpack.owner_player_id,backpack.definition_id,backpack.upgrade_level,
              backpack.location AS backpack_location,backpack.equipped_slot,
              backpack.inventory_slot_index,backpack.manor_id::text AS backpack_manor_id,
              backpack.manor_slot_index,backpack.version::text AS backpack_version,
              backpack.created_at AS backpack_created_at,backpack.updated_at AS backpack_updated_at,
              ''::text AS id,''::text AS operation_key,''::text AS dropped_by,
              ''::text AS region_code,''::text AS zone_id,''::text AS pile_id,0 AS pile_order,
              'active'::text AS status,0::double precision AS lat,0::double precision AS lon,
              now() AS created_at,now() AS expires_at,NULL::text AS pickup_operation_key,
              NULL::text AS picked_up_by,NULL::timestamptz AS picked_up_at,
              NULL::text AS manor_id,NULL::text AS space_id,NULL::double precision AS local_x,
              NULL::double precision AS local_y
       FROM player_backpack_instances backpack
       WHERE backpack.owner_player_id=$1 AND backpack.location<>'destroyed'
         AND ${ownedBackpackVisibleSql("backpack")}
       ORDER BY backpack.created_at,backpack.instance_id`,
      [playerId]
    )
  ]);
  const instances = rows.rows.map(mapBackpackDropInstance);
  const equipped: [
    BackpackInstanceSnapshot | null,
    BackpackInstanceSnapshot | null,
    BackpackInstanceSnapshot | null,
    BackpackInstanceSnapshot | null
  ] = [null, null, null, null];
  for (const instance of instances) {
    if (instance.location === "equipped" && instance.equippedSlot !== null) {
      equipped[instance.equippedSlot] = instance;
    }
  }
  const baseCapacity = Number(
    capacity.rows[0]?.base_capacity_grams ?? 100000
  );
  const backpackBonus = instances.reduce(
    (sum, instance) => sum + (instance.capacityBonusGrams ?? 0),
    0
  );
  return {
    playerId,
    revision: safeRevision(state.rows[0]?.revision ?? "0"),
    baseCapacityGrams: baseCapacity,
    backpackBonusGrams: backpackBonus,
    maximumCapacityGrams: baseCapacity + backpackBonus,
    equipped,
    instances
  };
}

async function groundEquipmentOperation(
  queryable: Queryable,
  operationKey: string
): Promise<GroundEquipmentOperationRow | null> {
  const result = await queryable.query<GroundEquipmentOperationRow>(
    `SELECT player_id,action,instance_id::text,result,completed_at
     FROM equipment_operations
     WHERE operation_key=$1`,
    [operationKey]
  );
  return result.rows[0] ?? null;
}

async function lockEquipmentDrop(
  queryable: Queryable,
  dropId: string
): Promise<EquipmentDropRow> {
  const result = await queryable.query<EquipmentDropRow>(
    `SELECT ${EQUIPMENT_DROP_COLUMNS}
     FROM world_equipment_drops
     WHERE id=$1
     FOR UPDATE`,
    [dropId]
  );
  if (!result.rows[0]) {
    throw new DroppedItemError("DROPPED_ITEM_NOT_FOUND", "Dropped equipment does not exist");
  }
  return result.rows[0];
}

export function assertDropLocationAndRange(
  player: DroppedItemActor,
  row: Pick<EquipmentDropRow | DroppedItemRow, "region_code" | "zone_id" | "lat" | "lon" | "manor_id" | "space_id" | "local_x" | "local_y" | "dropped_by">
): void {
  if (row.manor_id) {
    if (row.dropped_by !== player.playerId) {
      throw new DroppedItemError(
        "DROPPED_ITEM_OUT_OF_RANGE",
        "Only the Manor owner may pick up floor items"
      );
    }
    if (
      player.manorId !== row.manor_id ||
      player.spaceId !== row.space_id ||
      !player.localPosition ||
      row.local_x === null ||
      row.local_y === null
    ) {
      throw new DroppedItemError(
        "DROPPED_ITEM_OUT_OF_RANGE",
        "Dropped item is not in your current Manor room"
      );
    }
    const localDistance = Math.hypot(
      player.localPosition.x - row.local_x,
      player.localPosition.y - row.local_y
    );
    if (localDistance > MANOR_DROPPED_ITEM_PICKUP_EPSILON) {
      throw new DroppedItemError(
        "DROPPED_ITEM_OUT_OF_RANGE",
        "Move to the dropped item’s exact Manor position before picking it up"
      );
    }
    return;
  }
  const playerZoneId = player.zoneId ?? zoneIdForRegion(player.regionCode);
  const dropIsInterior = row.region_code.startsWith("interior:") ||
    row.zone_id.startsWith("interior:");
  const playerIsInterior = player.regionCode.startsWith("interior:") ||
    playerZoneId.startsWith("interior:");
  if (
    (dropIsInterior || playerIsInterior) &&
    (row.region_code !== player.regionCode || row.zone_id !== playerZoneId)
  ) {
    throw new DroppedItemError(
      "DROPPED_ITEM_OUT_OF_RANGE",
      "Dropped item is not in your current location"
    );
  }
  const distanceM = distanceMeters(player.position, {
    lat: storedDropLatitude(row),
    lon: Number(row.lon)
  });
  if (distanceM > DROPPED_ITEM_PICKUP_RADIUS_M) {
    throw new DroppedItemError(
      "DROPPED_ITEM_OUT_OF_RANGE",
      `Move within ${DROPPED_ITEM_PICKUP_RADIUS_M}m to pick up this item`
    );
  }
}

async function expireLockedEquipmentDrop(
  queryable: Queryable,
  row: EquipmentDropRow,
  now: Date
): Promise<void> {
  const operationKey = `ground-expire:${row.id}`;
  await queryable.query(
    `INSERT INTO equipment_operations (
       operation_key,player_id,action,instance_id,result,completed_at
     ) VALUES ($1,$2,'ground_expire',$3,$4::jsonb,$5)
     ON CONFLICT (operation_key) DO NOTHING`,
    [
      operationKey,
      row.dropped_by,
      row.equipment_instance_id,
      JSON.stringify({ dropId: row.id }),
      now
    ]
  );
  const moved = await queryable.query(
    `UPDATE equipment_instances
     SET location='destroyed'
     WHERE instance_id=$1 AND location='world_drop'`,
    [row.equipment_instance_id]
  );
  const expired = await queryable.query(
    `UPDATE world_equipment_drops
     SET status='expired',expired_at=$2
     WHERE id=$1 AND status='active'`,
    [row.id, now]
  );
  if (moved.rowCount !== 1 || expired.rowCount !== 1) {
    throw new Error("Dropped equipment expiry lost authoritative custody");
  }
}

async function ensureEquipmentInventoryScaffold(
  queryable: Queryable,
  playerId: string
): Promise<void> {
  await lockInventoryCapacity(queryable, playerId);
  await queryable.query(
    `INSERT INTO player_equipment_state (player_id)
     SELECT id FROM players WHERE id=$1
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
  await queryable.query(
    `SELECT inventory_revision
     FROM player_equipment_state
     WHERE player_id=$1
     FOR UPDATE`,
    [playerId]
  );
}

function requireDroppableItem(itemId: string) {
  try {
    const item = requireItemDefinition(itemId);
    if (!item.droppable) {
      throw new DroppedItemError(
        "DROP_ITEM_NOT_DROPPABLE",
        "This item cannot be dropped"
      );
    }
    return item;
  } catch (error) {
    if (error instanceof DroppedItemError) {
      throw error;
    }
    throw new DroppedItemError("DROP_UNKNOWN_ITEM", "Cannot drop an unknown item");
  }
}

function requirePositiveQuantity(quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new DroppedItemError(
      "DROP_INVALID_QUANTITY",
      "Drop quantity must be a positive whole number"
    );
  }
  return quantity;
}

function normalizePickupIntent(intent: DroppedItemPickupIntent): DroppedItemPickupIntent {
  if (intent.mode === "all") {
    return { mode: "all" };
  }
  if (!Number.isSafeInteger(intent.quantity) || intent.quantity <= 0) {
    throw new DroppedItemError(
      "DROPPED_ITEM_INVALID_PICKUP_QUANTITY",
      "Pickup quantity must be a positive whole number"
    );
  }
  return { mode: "quantity", quantity: intent.quantity };
}

function assertMatchingPickup(
  row: DroppedItemPickupRow,
  playerId: string,
  dropId: string,
  intent: DroppedItemPickupIntent
): void {
  const requestedQuantity = intent.mode === "quantity" ? intent.quantity : null;
  if (
    row.player_id !== playerId ||
    row.drop_id !== dropId ||
    row.pickup_mode !== intent.mode ||
    (row.requested_quantity === null ? null : BigInt(row.requested_quantity)) !==
      (requestedQuantity === null ? null : BigInt(requestedQuantity))
  ) {
    throw new DroppedItemError(
      "DROPPED_ITEM_PICKUP_REPLAY_CONFLICT",
      "Pickup request id was reused with different pickup details"
    );
  }
}

function normalizeVariant(variant: string | null): string {
  if (variant === null) {
    return DEFAULT_INVENTORY_VARIANT;
  }
  const normalized = variant.trim();
  if (!normalized || normalized.length > 80) {
    throw new DroppedItemError("DROP_INVALID_VARIANT", "Drop item variant is invalid");
  }
  return normalized;
}

function requestOperationKey(
  kind: "drop" | "pickup" | "equipment-drop" | "equipment-pickup" | "manor-equipment-drop" | "backpack-pickup",
  playerId: string,
  requestId: string
): string {
  const digest = createHash("sha256")
    .update(`${kind}\u0000${playerId}\u0000${requestId}`)
    .digest("hex");
  return `${kind}-dropped-item:${digest}`;
}

function dropIntentHash(
  playerId: string,
  itemId: ResourceType,
  variant: string,
  quantity: number,
  stackId: string | null
): string {
  return createHash("sha256")
    .update(`${playerId}\u001f${itemId}\u001f${variant}\u001f${quantity}\u001f${stackId ?? ""}`)
    .digest("hex");
}

function dropIdForOperation(operationKey: string): string {
  const digest = createHash("sha256").update(operationKey).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-` +
    `${digest.slice(16, 20)}-${digest.slice(20)}`;
}

// TODO(remove after the first deploy of the interior y-flip + DROPPED_ITEM_TTL_MS):
// temporary read shim for pre-flip dungeon ground drops.
/**
 * Dungeon drops written before the interior y-axis flip stored local +y as
 * positive latitude. Dungeon rooms only occupy local y >= 0, so every dungeon
 * drop written since the flip has lat <= 0 and a positive latitude can only be
 * a pre-flip row; read it mirrored. Only dungeon and Cistern Warrens instances
 * (`interior:dungeon:*`, `interior:sewer:*`) hold lat/lon drops indoors: Manor
 * drops store local coordinates with lat 0, and greenhouse/salon cannot drop.
 */
export function storedDropLatitude(
  row: Readonly<{ region_code: string; manor_id: string | null; lat: number | string }>
): number {
  const lat = Number(row.lat);
  const dungeonRegion = row.region_code.startsWith("interior:dungeon:") ||
    row.region_code.startsWith("interior:sewer:");
  return dungeonRegion && !row.manor_id && lat > 0 ? -lat : lat;
}

function rowToSnapshot(
  row: DroppedItemRow
): ResourceDroppedItemSnapshot {
  return {
    dropId: row.id,
    droppedBy: row.dropped_by,
    regionCode: row.region_code,
    zoneId: row.zone_id,
    pileId: row.pile_id,
    pileOrder: Number(row.pile_order),
    itemId: row.item_id as ResourceType,
    variant: snapshotVariant(row.variant),
    quantity: inventoryQuantityToSafeNumber(row.remaining_quantity),
    maxStack: Number(requireRuntimeItemDefinition(row.item_id).maxStack ?? Number.MAX_SAFE_INTEGER),
    status: row.status,
    lat: storedDropLatitude(row),
    lon: Number(row.lon),
    createdAt: dateIso(row.created_at),
    expiresAt: dateIso(row.expires_at),
    pickedUpBy: row.picked_up_by,
    pickedUpAt: row.picked_up_at === null ? null : dateIso(row.picked_up_at),
    ...(row.manor_id ? { manorId: row.manor_id } : {}),
    ...(row.space_id ? { spaceId: row.space_id } : {}),
    ...(row.local_x !== null ? { localX: Number(row.local_x) } : {}),
    ...(row.local_y !== null ? { localY: Number(row.local_y) } : {})
  };
}

function equipmentRowToSnapshot(
  row: EquipmentDropRow
): DroppedEquipmentResult["drop"] {
  return {
    dropId: row.id,
    droppedBy: row.dropped_by,
    regionCode: row.region_code,
    zoneId: row.zone_id,
    pileId: row.pile_id,
    pileOrder: Number(row.pile_order),
    itemId: row.item_id,
    equipmentInstanceId: row.equipment_instance_id,
    variant: null,
    quantity: row.status === "active" ? 1 : 0,
    maxStack: 1,
    status: row.status,
    lat: storedDropLatitude(row),
    lon: Number(row.lon),
    createdAt: dateIso(row.created_at),
    expiresAt: dateIso(row.expires_at),
    pickedUpBy: row.picked_up_by,
    pickedUpAt: row.picked_up_at === null ? null : dateIso(row.picked_up_at),
    ...(row.manor_id ? { manorId: row.manor_id } : {}),
    ...(row.space_id ? { spaceId: row.space_id } : {}),
    ...(row.local_x !== null ? { localX: Number(row.local_x) } : {}),
    ...(row.local_y !== null ? { localY: Number(row.local_y) } : {})
  };
}

function snapshotVariant(variant: string): string | null {
  return variant === DEFAULT_INVENTORY_VARIANT ? null : variant;
}

function requireDropRow(row: DroppedItemRow | undefined): DroppedItemRow {
  if (!row) {
    throw new Error("Dropped item database operation did not return a row");
  }
  return row;
}

function requireEquipmentDropRow(row: EquipmentDropRow | undefined): EquipmentDropRow {
  if (!row) {
    throw new Error("Dropped equipment database operation did not return a row");
  }
  return row;
}

function sortDropSnapshots(drops: DroppedItemSnapshot[]): DroppedItemSnapshot[] {
  return drops.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.dropId.localeCompare(right.dropId)
  );
}

function mapDropError(error: unknown, operation: "drop" | "pickup" = "drop"): Error {
  if (isInventoryCapacityError(error)) return new DroppedItemError("DROPPED_ITEM_CARRY_CAPACITY_EXCEEDED", "This would exceed your carrying capacity");
  if (error instanceof DroppedItemError) {
    return error;
  }
  if (error instanceof Error && error.message.includes("idempotency key")) {
    return new DroppedItemError(
      operation === "pickup"
        ? "DROPPED_ITEM_PICKUP_REPLAY_CONFLICT"
        : "DROP_REPLAY_CONFLICT",
      "Drop or pickup request id conflicts with another operation"
    );
  }
  return error instanceof Error ? error : new Error("Dropped item operation failed");
}

function dateIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function safeRevision(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
}
