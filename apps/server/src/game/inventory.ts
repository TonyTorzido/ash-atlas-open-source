import {
  DEFAULT_MANOR_TYPE_ID,
  emptyInventoryTotals,
  FACE_MASK_ITEM_ID,
  faceMaskDisplayName,
  MANOR_SKIN_ITEM_ID,
  manorSkinDisplayName,
  type PlayerInventoryItem,
  type PlayerInventorySnapshot,
  type InventoryItemType,
  type ResourceType
} from '@ash-atlas/shared';
import type pg from 'pg';
import {
  requireRuntimeItemDefinition,
  supportsInventoryItemVariant,
  type InventoryGrant
} from './items.js';

export const DEFAULT_INVENTORY_VARIANT = "default";

type Queryable = Pick<pg.Pool, "query">;

type InventoryRow = {
  player_id: string;
  resource_type: string;
  variant: string;
  quantity: string;
  version: string;
};

type InventoryStackAction = 'split' | 'restack' | 'move' | 'reorganize';

export type InventoryStackActionTiming = {
  action: InventoryStackAction;
  requestId: string;
  replayed: boolean;
  poolWaitMs: number;
  beginMs: number;
  capacityLockMs: number;
  reserveMs: number;
  readAndValidateMs: number;
  writeMs: number;
  snapshotMs: number;
  commitMs: number;
  totalMs: number;
};

type InventoryOperationRow = {
  operation_key: string;
  player_id: string;
  source: string;
  source_entity_type: string | null;
  source_entity_id: string | null;
  metadata?: unknown;
};

type InventoryEventRow = {
  item_id: string;
  variant: string;
  delta_quantity: string;
  quantity_after?: string;
  version_after?: string;
};

export const MAX_SAFE_INVENTORY_QUANTITY = 9_007_199_254_740_991n;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const SINGLE_CARRIED_TOOL_IDS = new Set<InventoryItemType>(["gardening_bucket", "water_bucket"]);

export type InventoryQuantityInput = number | bigint;
export type InventoryTransitionGrant = Omit<InventoryGrant, "quantity"> & {
  quantity: InventoryQuantityInput;
};

export type InventoryOperationInput = {
  operationKey: string;
  playerId: string;
  source: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  metadata?: Record<string, unknown>;
  grants: InventoryTransitionGrant[];
  allowPartial?: boolean;
};

export type InventoryGrantResult = {
  itemId: InventoryItemType;
  variant: string | null;
  requestedQuantity: number;
  grantedQuantity: number;
  remainderQuantity: number;
};

export type InventoryCapacityDiagnostic = Readonly<{
  currentWeightGrams: string;
  maximumWeightGrams: string;
  requestedQuantity: number;
  availableWeightGrams: string;
  /** Legacy diagnostic fields are decode-only. */
  unlockedSlots?: number;
  occupiedSlots?: number;
  existingCompatibleStackHasCapacity?: boolean;
}>;

export type InventoryOperationResult = {
  applied: boolean;
  inventory: PlayerInventorySnapshot;
  grants: InventoryGrantResult[];
};

export type InventoryDebitInput = Omit<InventoryOperationInput, "grants"> & {
  debits: InventoryTransitionGrant[];
  preferredStackId?: string | null;
};

export class InventoryStackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InventoryStackError";
  }
}

/**
 * A debit asked for more than the inventory holds. The message stays the historical one so callers
 * that still compare messages keep working; new callers use `isInventoryShortageError`.
 */
export class InventoryShortageError extends Error {
  readonly code = "INVENTORY_SHORTAGE" as const;
  constructor() {
    super("Inventory does not contain enough items");
    this.name = "InventoryShortageError";
  }
}

export function isInventoryShortageError(error: unknown): error is InventoryShortageError {
  return error instanceof InventoryShortageError;
}

/**
 * A debit would take the Manor skin that is equipped on the player's Manor out of the inventory.
 * The database refuses the same at commit (1083); this is the friendly early refusal.
 */
export class InventoryItemEquippedError extends Error {
  readonly code = "INVENTORY_ITEM_EQUIPPED" as const;
  constructor(readonly manorTypeId: string, message = manorSkinEquippedReason(manorTypeId)) {
    super(message);
    this.name = "InventoryItemEquippedError";
  }
}

export function isInventoryItemEquippedError(error: unknown): error is InventoryItemEquippedError {
  return error instanceof InventoryItemEquippedError ||
    // The commit-time guard of 1083, for paths that write player_inventory directly.
    (typeof error === "object" && error !== null &&
      ((error as { constraint?: unknown }).constraint === "player_manor_skin_equipped" ||
        (error as { constraint?: unknown }).constraint === "player_face_mask_worn"));
}

/** Why an equipped Manor skin cannot leave the inventory. */
export function manorSkinEquippedReason(manorTypeId: string): string {
  return `Your ${manorSkinDisplayName(manorTypeId)} is equipped on your Manor. Unequip it first.`;
}

/**
 * Refuse a debit that would leave fewer than one of the equipped Manor skin. Locks the owner's
 * Manor row FOR SHARE (after the inventory carry lock, the order every inventory writer uses) so
 * a concurrent equip either finishes first and is seen here, or waits and sees this debit.
 */
async function assertEquippedManorSkinKept(
  queryable: Queryable,
  playerId: string,
  debits: readonly NormalizedGrant[]
): Promise<void> {
  if (!debits.some((debit) => debit.itemId === MANOR_SKIN_ITEM_ID)) return;
  const manor = await queryable.query<{ manor_type_id: string; skin_copy_id: string | null }>(
    "SELECT manor_type_id,skin_copy_id FROM player_manors WHERE owner_player_id=$1 FOR SHARE",
    [playerId]
  );
  const equipped = manor.rows[0]?.manor_type_id;
  const equippedCopy = manor.rows[0]?.skin_copy_id;
  if (!equipped || equipped === DEFAULT_MANOR_TYPE_ID || !equippedCopy) return;
  // Skins are per-copy items (1202): only the equipped copy is locked.
  if (debits.some((entry) => entry.itemId === MANOR_SKIN_ITEM_ID && entry.variant === equippedCopy)) {
    throw new InventoryItemEquippedError(equipped);
  }
}

/** Why the worn mask cannot leave the inventory. */
export function faceMaskWornReason(appearanceId: string): string {
  return `Your ${faceMaskDisplayName(appearanceId)} is being worn. Take it off first.`;
}

/** Refuse a debit that would leave fewer than one of the worn mask (1200 refuses the same at commit). */
async function assertWornFaceMaskKept(
  queryable: Queryable,
  playerId: string,
  debits: readonly NormalizedGrant[]
): Promise<void> {
  if (!debits.some((debit) => debit.itemId === FACE_MASK_ITEM_ID)) return;
  const player = await queryable.query<{ mask_appearance_id: string | null; mask_copy_id: string | null }>(
    "SELECT mask_appearance_id,mask_copy_id FROM players WHERE id=$1",
    [playerId]
  );
  const worn = player.rows[0]?.mask_appearance_id;
  const wornCopy = player.rows[0]?.mask_copy_id;
  if (!worn || !wornCopy) return;
  // Masks are per-copy items (1202): only the worn copy is locked.
  if (debits.some((entry) => entry.itemId === FACE_MASK_ITEM_ID && entry.variant === wornCopy)) {
    throw new InventoryItemEquippedError(worn, faceMaskWornReason(worn));
  }
}

export class InventoryCapacityError extends Error {
  constructor(readonly grants: InventoryGrantResult[], readonly diagnostic?: InventoryCapacityDiagnostic, message = "This would exceed your carrying capacity") {
    super(message);
    this.name = "InventoryCapacityError";
  }
}
/** PostgreSQL is also authoritative for instance moves that bypass commodity grants. */
export function isInventoryCapacityError(error: unknown): boolean {
  if (error instanceof InventoryCapacityError)
    return true;
  if (!error || typeof error !== 'object')
    return false;
  const databaseError = error as {
    code?: unknown;
    constraint?: unknown;
  };
  return databaseError.code === '23514' && databaseError.constraint === 'player_inventory_carry_capacity';
}

export class InventoryService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly observeStackActionTiming?: (
      timing: InventoryStackActionTiming
    ) => void
  ) {}
  async getInventorySnapshot(playerId: string): Promise<PlayerInventorySnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockInventoryCapacity(client, playerId);
      const snapshot = await inventorySnapshot(client, playerId);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async canAfford(
    playerId: string,
    required: ReadonlyArray<{ itemId: ResourceType; variant?: string | null; quantity: number }>
  ): Promise<boolean> {
    if (required.length === 0) return true;
    const result = await this.pool.query<{ affordable: boolean }>(
      `WITH required(resource_type, variant, quantity) AS (
         SELECT * FROM unnest($2::text[], $3::text[], $4::bigint[])
       )
       SELECT count(inventory.resource_type) = $5::integer
              AND bool_and(inventory.quantity >= required.quantity) AS affordable
       FROM required
       LEFT JOIN player_inventory inventory
         ON inventory.player_id = $1
        AND inventory.resource_type = required.resource_type
        AND inventory.variant = required.variant`,
      [
        playerId,
        required.map((item) => item.itemId),
        required.map((item) => item.variant ?? DEFAULT_INVENTORY_VARIANT),
        required.map((item) => item.quantity),
        required.length
      ]
    );
    return result.rows[0]?.affordable === true;
  }

  async replayCompletedOperationInTransaction(
    queryable: Queryable,
    input: InventoryOperationInput
  ): Promise<InventoryOperationResult | null> {
    const normalized = normalizeOperation(input);
    const result = await queryable.query<InventoryOperationRow>(
      `
      SELECT operation_key, player_id, source, source_entity_type, source_entity_id
      FROM inventory_operations
      WHERE operation_key = $1
        AND player_id = $2
        AND source = $3
        AND source_entity_type IS NOT DISTINCT FROM $4
        AND source_entity_id IS NOT DISTINCT FROM $5
      `,
      [
        normalized.operationKey,
        normalized.playerId,
        normalized.source,
        normalized.sourceEntityType,
        normalized.sourceEntityId
      ]
    );
    if (result.rowCount !== 1) {
      return null;
    }
    await assertMatchingCompletedOperation(queryable, normalized);
    return {
      applied: false,
      inventory: await inventorySnapshot(queryable, normalized.playerId),
      grants: await completedGrantResults(queryable, normalized)
    };
  }
  async snapshotInTransaction(queryable: Queryable, playerId: string): Promise<PlayerInventorySnapshot> {
    await lockInventoryCapacity(queryable, playerId);
    return inventorySnapshot(queryable, playerId);
  }
  /** Retained endpoints explicitly reject old clients; there is no stack/grid mutation. */
  async splitStack(_playerId: string, _requestId: string, _entryId: string, _quantity: number): Promise<PlayerInventorySnapshot> {
    void _playerId;
    void _requestId;
    void _entryId;
    void _quantity;
    throw new InventoryStackError('INVENTORY_ACTION_RETIRED', 'Inventory uses quantity balances. Choose a quantity when dropping, selling, or storing an item.');
  }
  async restackStack(playerId: string, requestId: string, entryId: string): Promise<PlayerInventorySnapshot> {
    return this.splitStack(playerId, requestId, entryId, 0);
  }
  async moveStack(playerId: string, requestId: string, entryId: string, _target: number): Promise<PlayerInventorySnapshot> {
    void _target;
    return this.splitStack(playerId, requestId, entryId, 0);
  }
  async reorganize(playerId: string, requestId: string): Promise<PlayerInventorySnapshot> {
    return this.splitStack(playerId, requestId, '', 0);
  }

  async grantItemsForOperation(
    input: InventoryOperationInput
  ): Promise<InventoryOperationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.grantItemsForOperationInTransaction(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async grantItemsForOperationInTransaction(queryable: Queryable, input: InventoryOperationInput): Promise<InventoryOperationResult> {
    const normalized = normalizeOperation(input);
    await lockInventoryCapacity(queryable, normalized.playerId);
    const requestedMetadata = normalized.grants.map((grant) => ({
      itemId: grant.itemId,
      variant: grant.variant,
      quantity: grant.quantity.toString()
    }));
    const reserved = await queryable.query<InventoryOperationRow>(`
   INSERT INTO inventory_operations (
    operation_key, player_id, source, source_entity_type, source_entity_id, metadata
   )
   VALUES ($1, $2, $3, $4, $5, $6::jsonb)
   ON CONFLICT (operation_key) DO NOTHING
   RETURNING operation_key, player_id, source, source_entity_type, source_entity_id
   `, [
      normalized.operationKey,
      normalized.playerId,
      normalized.source,
      normalized.sourceEntityType,
      normalized.sourceEntityId,
      JSON.stringify({
        ...normalized.metadata,
        inventoryRequestedGrants: requestedMetadata
      })
    ]);
    if (reserved.rowCount === 0) {
      await assertMatchingCompletedOperation(queryable, normalized);
      return {
        applied: false,
        inventory: await inventorySnapshot(queryable, normalized.playerId),
        grants: await completedGrantResults(queryable, normalized)
      };
    }
    const grantResults: InventoryGrantResult[] = [];
    for (const grant of normalized.grants) {
      if (SINGLE_CARRIED_TOOL_IDS.has(grant.itemId) && grant.variant === DEFAULT_INVENTORY_VARIANT) {
        const existing = await queryable.query<{ quantity: string }>(
          `SELECT quantity::text
           FROM player_inventory
           WHERE player_id=$1 AND resource_type=$2 AND variant=$3 AND quantity>0
           LIMIT 1`,
          [normalized.playerId, grant.itemId, grant.variant]
        );
        if (existing.rows[0] || grant.quantity > 1n) {
          const label = grant.itemId === "water_bucket" ? "Water Bucket" : "Gardening Bucket";
          throw new InventoryCapacityError([], undefined, `You can carry only one ${label}.`);
        }
      }
      const fitting = await fittingGrantQuantity(queryable, normalized.playerId, grant);
      const result = grantResult(grant, fitting.quantity);
      grantResults.push(result);
      if (fitting.quantity < grant.quantity && !input.allowPartial) {
        throw new InventoryCapacityError(grantResults, fitting.diagnostic);
      }
      if (fitting.quantity === 0n)
        continue;
      const stack = await queryable.query<InventoryRow>(`
    INSERT INTO player_inventory (
     player_id, resource_type, variant, quantity, version, updated_at
    )
    VALUES ($1, $2, $3, $4::bigint, 1, now())
    ON CONFLICT (player_id, resource_type, variant)
    DO UPDATE SET
     quantity = player_inventory.quantity + EXCLUDED.quantity,
     version = player_inventory.version + 1,
     updated_at = now()
    WHERE player_inventory.quantity + EXCLUDED.quantity
        BETWEEN 0 AND $5::bigint
     AND player_inventory.version < $6::bigint
    RETURNING player_id, resource_type, variant, quantity::text, version::text
    `, [
        normalized.playerId,
        grant.itemId,
        grant.variant,
        fitting.quantity.toString(),
        MAX_SAFE_INVENTORY_QUANTITY.toString(),
        POSTGRES_BIGINT_MAX.toString()
      ]);
      const stackRow = stack.rows[0];
      if (!stackRow) {
        throw new Error("Inventory update would produce an invalid quantity");
      }
      await queryable.query(`
    INSERT INTO inventory_events (
     operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
     version_after, source, source_entity_type, source_entity_id, metadata
    )
    VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7::bigint,
        $8, $9, $10, $11::jsonb)
    `, [
        normalized.operationKey,
        normalized.playerId,
        grant.itemId,
        grant.variant,
        fitting.quantity.toString(),
        stackRow.quantity,
        stackRow.version,
        normalized.source,
        normalized.sourceEntityType,
        normalized.sourceEntityId,
        JSON.stringify(normalized.metadata)
      ]);
    }
    return {
      applied: true,
      inventory: await inventorySnapshot(queryable, normalized.playerId),
      grants: grantResults
    };
  }
  async debitItemsForOperationInTransaction(queryable: Queryable, input: InventoryDebitInput): Promise<InventoryOperationResult> {
    const normalized = normalizeOperation({ ...input, grants: input.debits });
    await lockInventoryCapacity(queryable, normalized.playerId);
    const reserved = await queryable.query<InventoryOperationRow>(`
   INSERT INTO inventory_operations (
    operation_key, player_id, source, source_entity_type, source_entity_id, metadata
   )
   VALUES ($1, $2, $3, $4, $5, $6::jsonb)
   ON CONFLICT (operation_key) DO NOTHING
   RETURNING operation_key, player_id, source, source_entity_type, source_entity_id
   `, [
      normalized.operationKey,
      normalized.playerId,
      normalized.source,
      normalized.sourceEntityType,
      normalized.sourceEntityId,
      JSON.stringify(normalized.metadata)
    ]);
    if (reserved.rowCount === 0) {
      const operation = await queryable.query<InventoryOperationRow>(`SELECT operation_key, player_id, source, source_entity_type, source_entity_id
     FROM inventory_operations WHERE operation_key = $1`, [normalized.operationKey]);
      const row = operation.rows[0];
      if (!row || row.player_id !== normalized.playerId || row.source !== normalized.source ||
        row.source_entity_type !== normalized.sourceEntityType ||
        row.source_entity_id !== normalized.sourceEntityId)
        throw new Error("Inventory debit idempotency key conflicts with another operation");
      const events = await queryable.query<InventoryEventRow>(`SELECT item_id, variant, delta_quantity FROM inventory_events
     WHERE operation_key = $1 ORDER BY item_id ASC, variant ASC`, [normalized.operationKey]);
      const existingDebits = events.rows.map((event) => ({
        itemId: event.item_id,
        variant: event.variant,
        quantity: -BigInt(event.delta_quantity)
      }));
      if (!sameGrants(existingDebits, normalized.grants)) {
        throw new Error("Inventory debit idempotency key was reused with different debits");
      }
      return {
        applied: false,
        inventory: await inventorySnapshot(queryable, normalized.playerId),
        grants: normalized.grants.map((debit) => grantResult(debit, debit.quantity))
      };
    }
    if (input.preferredStackId) {
      const owned = await queryable.query<{
        resource_type: string;
        variant: string;
      }>('SELECT resource_type,variant FROM player_inventory WHERE player_id=$1 AND entry_id=$2::uuid', [normalized.playerId, input.preferredStackId]);
      const row = owned.rows[0];
      if (!row || !normalized.grants.some(grant => grant.itemId === row.resource_type && grant.variant === row.variant)) {
        throw new Error('Inventory entry identity no longer matches the requested items');
      }
    }
    await assertEquippedManorSkinKept(queryable, normalized.playerId, normalized.grants);
    await assertWornFaceMaskKept(queryable, normalized.playerId, normalized.grants);
    const requestedValues = normalized.grants.map((_, index) => {
      const offset = 2 + index * 3;
      return `($${offset}::text,$${offset + 1}::text,$${offset + 2}::bigint)`;
    }).join(",");
    const requestedParameters: Array<string> = [normalized.playerId];
    for (const debit of normalized.grants) {
      requestedParameters.push(debit.itemId, debit.variant, debit.quantity.toString());
    }
    requestedParameters.push(POSTGRES_BIGINT_MAX.toString());
    const maximumVersionParameter = requestedParameters.length;
    const updated = await queryable.query<InventoryRow>(`WITH requested(resource_type, variant, quantity) AS (
     VALUES ${requestedValues}
    ), locked AS MATERIALIZED (
     SELECT inventory.player_id, inventory.resource_type, inventory.variant,
        inventory.quantity, inventory.version
     FROM player_inventory inventory
     JOIN requested
      ON requested.resource_type = inventory.resource_type
     AND requested.variant = inventory.variant
     WHERE inventory.player_id = $1
     ORDER BY inventory.resource_type, inventory.variant
     FOR UPDATE OF inventory
    ), valid AS (
     SELECT count(*) = ${normalized.grants.length}
         AND bool_and(locked.quantity >= requested.quantity)
         AND bool_and(locked.version < $${maximumVersionParameter}::bigint) AS ok
     FROM locked
     JOIN requested USING (resource_type, variant)
    )
    UPDATE player_inventory inventory
    SET quantity = inventory.quantity - requested.quantity,
      version = inventory.version + 1,
      updated_at = now()
    FROM requested, valid
    WHERE valid.ok
     AND inventory.player_id = $1
     AND inventory.resource_type = requested.resource_type
     AND inventory.variant = requested.variant
    RETURNING inventory.player_id, inventory.resource_type, inventory.variant,
         inventory.quantity::text, inventory.version::text`, requestedParameters);
    if (updated.rows.length !== normalized.grants.length) {
      throw new InventoryShortageError();
    }
    const rows = [...updated.rows].sort((left, right) => left.resource_type.localeCompare(right.resource_type) ||
      left.variant.localeCompare(right.variant));
    await queryable.query(`INSERT INTO inventory_events (
     operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
     version_after, source, source_entity_type, source_entity_id, metadata
    )
    SELECT $1, $2, event.item_id, event.variant, event.delta_quantity,
       event.quantity_after, event.version_after, $3, $4, $5, $6::jsonb
    FROM UNNEST(
     $7::text[], $8::text[], $9::bigint[], $10::bigint[], $11::bigint[]
    ) AS event(item_id, variant, delta_quantity, quantity_after, version_after)`, [
      normalized.operationKey,
      normalized.playerId,
      normalized.source,
      normalized.sourceEntityType,
      normalized.sourceEntityId,
      JSON.stringify(normalized.metadata),
      rows.map((row) => row.resource_type),
      rows.map((row) => row.variant),
      normalized.grants.map((debit) => (-debit.quantity).toString()),
      rows.map((row) => row.quantity),
      rows.map((row) => row.version)
    ]);
    return {
      applied: true,
      inventory: await inventorySnapshot(queryable, normalized.playerId),
      grants: normalized.grants.map((debit) => grantResult(debit, debit.quantity))
    };
  }
  async lockPlayerInventoryForOperationInTransaction(queryable: Queryable, playerId: string): Promise<void> {
    await lockInventoryCapacity(queryable, playerId);
  }
}

async function assertMatchingCompletedOperation(
  queryable: Queryable,
  input: Required<
    Pick<
      InventoryOperationInput,
      "operationKey" | "playerId" | "source" | "sourceEntityType" | "sourceEntityId" | "metadata"
    >
  > & { grants: NormalizedGrant[] }
): Promise<void> {
  const operation = await queryable.query<InventoryOperationRow>(
    `
    SELECT operation_key, player_id, source, source_entity_type, source_entity_id, metadata
    FROM inventory_operations
    WHERE operation_key = $1
    `,
    [input.operationKey]
  );
  const row = operation.rows[0];
  if (
    !row ||
    row.player_id !== input.playerId ||
    row.source !== input.source ||
    row.source_entity_type !== input.sourceEntityType ||
    row.source_entity_id !== input.sourceEntityId
  ) {
    throw new Error("Inventory idempotency key conflicts with another operation");
  }
  const requested = requestedGrantsFromMetadata(row.metadata);
  if (requested && !sameGrants(requested, input.grants)) {
    throw new Error("Inventory idempotency key was reused with different grants");
  }

  const events = await queryable.query<InventoryEventRow>(
    `
    SELECT item_id, variant, delta_quantity
    FROM inventory_events
    WHERE operation_key = $1
    ORDER BY item_id ASC, variant ASC
    `,
    [input.operationKey]
  );
  const existingGrants = events.rows.map((event) => ({
    itemId: event.item_id,
    variant: event.variant,
    quantity: BigInt(event.delta_quantity)
  }));
  if (!requested && !sameGrants(existingGrants, input.grants)) {
    throw new Error("Inventory idempotency key was reused with different grants");
  }
}

async function completedGrantResults(
  queryable: Queryable,
  input: { operationKey: string; grants: NormalizedGrant[] }
): Promise<InventoryGrantResult[]> {
  const events = await queryable.query<InventoryEventRow>(
    `SELECT item_id, variant, delta_quantity
     FROM inventory_events
     WHERE operation_key = $1`,
    [input.operationKey]
  );
  const grantedByIdentity = new Map(
    events.rows.map((event) => [
      `${event.item_id}\u0000${event.variant}`,
      BigInt(event.delta_quantity)
    ])
  );
  return input.grants.map((grant) => grantResult(
    grant,
    grantedByIdentity.get(`${grant.itemId}\u0000${grant.variant}`) ?? 0n
  ));
}

type NormalizedGrant = {
  itemId: InventoryItemType;
  variant: string;
  quantity: bigint;
};

function normalizeOperation(input: InventoryOperationInput) {
  if (!input.operationKey || input.operationKey.length > 240) {
    throw new Error("Inventory operation key is required and must be at most 240 characters");
  }
  if (!input.playerId || !input.source) {
    throw new Error("Inventory operation player and source are required");
  }
  if (input.grants.length === 0) {
    throw new Error("Inventory operation must include at least one grant");
  }
  const combined = new Map<string, NormalizedGrant>();
  for (const grant of input.grants) {
    const definition = requireRuntimeItemDefinition(grant.itemId);
    const quantity = normalizeQuantity(grant.quantity);
    if (quantity <= 0n || quantity > MAX_SAFE_INVENTORY_QUANTITY) {
      throw new Error("Inventory grant quantity must be a positive integer");
    }
    const variant = grant.variant ?? DEFAULT_INVENTORY_VARIANT;
    if ((grant.itemId === "seed" || grant.itemId === "produce") &&
      !supportsInventoryItemVariant(grant.itemId, variant)) {
      throw new Error(`Inventory variant is not supported for ${grant.itemId}`);
    }
    const key = `${definition.itemId}\u0000${variant}`;
    const existing = combined.get(key);
    combined.set(key, {
      itemId: definition.itemId as InventoryItemType,
      variant,
      quantity: (existing?.quantity ?? 0n) + quantity
    });
  }
  if ([...combined.values()].some((grant) => grant.quantity > MAX_SAFE_INVENTORY_QUANTITY)) {
    throw new Error("Inventory grant quantity exceeds the safe protocol range");
  }
  return {
    operationKey: input.operationKey,
    playerId: input.playerId,
    source: input.source,
    sourceEntityType: input.sourceEntityType ?? null,
    sourceEntityId: input.sourceEntityId ?? null,
    metadata: input.metadata ?? {},
    grants: [...combined.values()].sort((left, right) => left.itemId.localeCompare(right.itemId) || left.variant.localeCompare(right.variant))
  };
}

async function inventorySnapshot(
  queryable: Queryable,
  playerId: string
): Promise<PlayerInventorySnapshot> {
  const weight = await inventoryWeightSnapshotInTransaction(queryable, playerId);
  const result = await queryable.query<InventoryRow & {
    entry_id: string;
    unit_weight_grams: number;
    rod_id: string | null;
    uses_remaining: number | null;
    copy_look: string | null;
    copy_tag: string | null;
    copy_buyer_name: string | null;
    copy_equipped: boolean | null;
  }>(
    `SELECT inventory.player_id, inventory.entry_id::text, inventory.resource_type,
            inventory.variant, inventory.quantity::text, inventory.version::text,
            definition.unit_weight_grams,
            rod.rod_id::text AS rod_id, rod.uses_remaining,
            copy.look AS copy_look, copy.tag AS copy_tag, copy.original_buyer_name AS copy_buyer_name,
            (copy.copy_id IS NOT NULL AND (
              copy.copy_id = (SELECT p.mask_copy_id FROM players p WHERE p.id = inventory.player_id) OR
              copy.copy_id = (SELECT m.skin_copy_id FROM player_manors m WHERE m.owner_player_id = inventory.player_id)
            )) AS copy_equipped
     FROM player_inventory inventory
     JOIN item_definitions definition ON definition.item_id = inventory.resource_type
     LEFT JOIN fishing_rods rod
       ON inventory.resource_type = 'fishing_rod'
      AND rod.player_id = inventory.player_id
      AND rod.rod_id::text = inventory.variant
     LEFT JOIN shop_item_copies copy
       ON inventory.resource_type IN ('face_mask', 'manor_skin')
      AND copy.copy_id = inventory.variant
     WHERE inventory.player_id = $1 AND inventory.quantity > 0
     ORDER BY inventory.resource_type, inventory.variant`,
    [playerId]
  );
  const revision = await queryable.query<{ inventory_revision: string }>(
    "SELECT inventory_revision::text FROM player_inventory_capacities WHERE player_id = $1",
    [playerId]
  );
  const totals = emptyInventoryTotals();
  const items: PlayerInventoryItem[] = result.rows.map((row) => {
    const resourceType = row.resource_type as InventoryItemType;
    if (resourceType === "fishing_rod") {
      totals.fishing_rod = inventoryQuantityToSafeNumber(
        BigInt(totals.fishing_rod ?? 0) + BigInt(row.quantity)
      );
    } else {
      totals[resourceType] = inventoryQuantityToSafeNumber(
        BigInt(totals[resourceType] ?? 0) + BigInt(row.quantity)
      );
    }
    return {
      playerId,
      resourceType,
      variant: row.variant === DEFAULT_INVENTORY_VARIANT ? null : row.variant,
      quantity: inventoryQuantityToSafeNumber(row.quantity),
      entryId: row.entry_id,
      stackId: row.entry_id,
      unitWeightGrams: row.unit_weight_grams,
      totalWeightGrams: (BigInt(row.quantity) * BigInt(row.unit_weight_grams)).toString(),
      ...(row.rod_id ? { rodId: row.rod_id, usesRemaining: Number(row.uses_remaining ?? 0) } : {}),
      ...(row.copy_look && row.copy_tag && row.copy_buyer_name
        ? {
            look: row.copy_look,
            provenance: { tag: row.copy_tag, originalBuyerName: row.copy_buyer_name },
            ...(row.copy_equipped ? { equipped: true } : {})
          }
        : {})
    };
  });
  return {
    playerId,
    revision: inventoryQuantityToSafeNumber(revision.rows[0]?.inventory_revision ?? "0"),
    items,
    totals,
    currentWeightGrams: weight.currentWeightGrams.toString(),
    maximumWeightGrams: weight.maximumWeightGrams.toString()
  };
}

async function fittingGrantQuantity(
  queryable: Queryable,
  playerId: string,
  grant: NormalizedGrant
): Promise<{ quantity: bigint; diagnostic: InventoryCapacityDiagnostic }> {
  const weight = await inventoryWeightSnapshotInTransaction(queryable, playerId);
  const remaining = remainingInventoryWeight(weight);
  const fitting = fittingByWeight(remaining, requireRuntimeItemDefinition(grant.itemId).unitWeightGrams, grant.quantity);
  return {
    quantity: fitting < grant.quantity ? fitting : grant.quantity,
    diagnostic: {
      currentWeightGrams: weight.currentWeightGrams.toString(),
      maximumWeightGrams: weight.maximumWeightGrams.toString(),
      availableWeightGrams: remaining.toString(),
      requestedQuantity: inventoryQuantityToSafeNumber(grant.quantity)
    }
  };
}

function grantResult(
  grant: NormalizedGrant,
  grantedQuantity: bigint
): InventoryGrantResult {
  return {
    itemId: grant.itemId,
    variant: grant.variant === DEFAULT_INVENTORY_VARIANT ? null : grant.variant,
    requestedQuantity: inventoryQuantityToSafeNumber(grant.quantity),
    grantedQuantity: inventoryQuantityToSafeNumber(grantedQuantity),
    remainderQuantity: inventoryQuantityToSafeNumber(grant.quantity - grantedQuantity)
  };
}

function requestedGrantsFromMetadata(metadata: unknown): NormalizedGrant[] | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).inventoryRequestedGrants;
  if (!Array.isArray(value)) return null;
  const grants: NormalizedGrant[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.itemId !== "string" ||
      typeof record.variant !== "string" ||
      typeof record.quantity !== "string"
    ) return null;
    grants.push({
      itemId: record.itemId as InventoryItemType,
      variant: record.variant,
      quantity: BigInt(record.quantity)
    });
  }
  return grants;
}
/** The capacity row serializes every on-person quantity and instance mutation. */
export async function lockInventoryCapacity(
  queryable: Queryable,
  playerId: string
): Promise<number> {
  const result = await queryable.query<{ maximum_weight_grams: string }>(
    "SELECT lock_player_inventory_carry($1)::text AS maximum_weight_grams",
    [playerId]
  );
  return inventoryQuantityToSafeNumber(result.rows[0]!.maximum_weight_grams);
}

export type InventoryWeightSnapshot = {
  currentWeightGrams: bigint;
  maximumWeightGrams: bigint;
  allowedWeightGrams: bigint;
};

export async function inventoryWeightSnapshotInTransaction(
  queryable: Queryable,
  playerId: string
): Promise<InventoryWeightSnapshot> {
  await lockInventoryCapacity(queryable, playerId);
  const result = await queryable.query<{
    current_weight: string;
    maximum_weight: string;
    allowed_weight: string;
  }>(
    `SELECT player_inventory_weight_grams($1)::text AS current_weight,
            player_inventory_maximum_grams($1)::text AS maximum_weight,
            player_inventory_allowed_grams($1)::text AS allowed_weight`,
    [playerId]
  );
  const row = result.rows[0]!;
  return {
    currentWeightGrams: BigInt(row.current_weight),
    maximumWeightGrams: BigInt(row.maximum_weight),
    allowedWeightGrams: BigInt(row.allowed_weight)
  };
}

export async function assertInventoryWeightInTransaction(
  queryable: Queryable,
  playerId: string,
  additionalWeightGrams = 0n
): Promise<void> {
  if (additionalWeightGrams < 0n) {
    throw new Error("Additional weight cannot be negative");
  }
  const weight = await inventoryWeightSnapshotInTransaction(queryable, playerId);
  if (weight.currentWeightGrams + additionalWeightGrams > weight.allowedWeightGrams) {
    throw new InventoryCapacityError([], {
      currentWeightGrams: weight.currentWeightGrams.toString(),
      maximumWeightGrams: weight.maximumWeightGrams.toString(),
      availableWeightGrams: remainingInventoryWeight(weight).toString(),
      requestedQuantity: 0
    });
  }
}

export async function fittingInventoryQuantityInTransaction(
  queryable: Queryable,
  playerId: string,
  itemId: string,
  requestedQuantity: bigint
): Promise<bigint> {
  if (requestedQuantity < 0n) {
    throw new Error("Requested quantity cannot be negative");
  }
  const weight = await inventoryWeightSnapshotInTransaction(queryable, playerId);
  const fitting = fittingByWeight(
    remainingInventoryWeight(weight),
    requireRuntimeItemDefinition(itemId).unitWeightGrams,
    requestedQuantity
  );
  return fitting < requestedQuantity ? fitting : requestedQuantity;
}

/** Units that fit in the remaining grams; weightless items (Lumen) always fit. */
function fittingByWeight(remainingGrams: bigint, unitWeightGrams: number, requested: bigint): bigint {
  return unitWeightGrams === 0 ? requested : remainingGrams / BigInt(unitWeightGrams);
}

function remainingInventoryWeight(weight: InventoryWeightSnapshot): bigint {
  return weight.allowedWeightGrams > weight.currentWeightGrams
    ? weight.allowedWeightGrams - weight.currentWeightGrams
    : 0n;
}

export function inventoryQuantityToSafeNumber(value: string | bigint): number {
  const quantity = typeof value === "bigint" ? value : BigInt(value);
  if (quantity < 0n || quantity > MAX_SAFE_INVENTORY_QUANTITY) {
    throw new Error("Inventory quantity is outside the safe protocol range");
  }
  return Number(quantity);
}

export function inventoryQuantityFromBigInt(value: bigint): number {
  if (value <= 0n || value > MAX_SAFE_INVENTORY_QUANTITY) {
    throw new Error("Inventory mutation quantity is outside the safe protocol range");
  }
  return Number(value);
}

function normalizeQuantity(value: InventoryQuantityInput): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new Error("Inventory grant quantity must be a positive integer");
  }
  return BigInt(value);
}

function sameGrants(
  left: Array<{ itemId: string; variant: string; quantity: bigint }>,
  right: Array<{ itemId: string; variant: string; quantity: bigint }>
): boolean {
  return left.length === right.length && left.every((grant, index) => {
    const other = right[index];
    return other !== undefined && grant.itemId === other.itemId &&
      grant.variant === other.variant && grant.quantity === other.quantity;
  });
}
