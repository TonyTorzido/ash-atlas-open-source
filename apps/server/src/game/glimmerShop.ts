import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  GLIMMER_SHOP_MAX_LINES,
  GLIMMER_SHOP_MAX_QUANTITY,
  GLIMMER_SHOP_SKU_PATTERN,
  type BuyShopItemsInput,
  faceMaskDisplayName,
  manorSkinDisplayName,
  type EquipmentDefinitionId,
  type GlimmerShopCatalogEdit,
  type GlimmerShopCatalogItem,
  type GlimmerShopCatalogSnapshot,
  type GlimmerShopErrorCode,
  type GlimmerShopKind,
  type GlimmerShopPurchaseLine,
  type GlimmerShopPurchaseResult,
  type GlimmerShopSource
} from "@ash-atlas/shared";
import type pg from "pg";

import { EquipmentError, type EquipmentService } from "./equipment.js";
import { isInventoryCapacityError, type InventoryService } from "./inventory.js";
import {
  PremiumWalletOperationError,
  type PremiumWalletService
} from "./premiumWallet.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A random 40-bit Crockford base32 tag, `XXXX-XXXX`. Never derived from a counter or time. */
export function randomShopTag(): string {
  let bits = BigInt(`0x${randomBytes(5).toString("hex")}`);
  let out = "";
  for (let index = 0; index < 8; index += 1) {
    out = CROCKFORD_BASE32[Number(bits & 31n)]! + out;
    bits >>= 5n;
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Record one shop copy with a fresh unique tag (retries on the rare tag collision). */
async function insertShopCopy(
  client: pg.PoolClient,
  copy: Readonly<{
    copyId: string;
    itemId: string;
    look: string;
    displayName: string | null;
    buyer: Readonly<{ playerId: string; name: string }>;
    accountId: string;
    requestId: string;
  }>
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tag = randomShopTag();
    const inserted = await client.query(
      `INSERT INTO shop_item_copies
         (copy_id,item_id,look,tag,original_buyer_player_id,original_buyer_name,purchase_account_id,purchase_request_id,display_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tag) DO NOTHING`,
      [copy.copyId, copy.itemId, copy.look, tag, copy.buyer.playerId, copy.buyer.name, copy.accountId, copy.requestId, copy.displayName]
    );
    if (inserted.rowCount === 1) return tag;
  }
  throw new Error("Could not allocate a unique shop tag");
}

export class GlimmerShopError extends Error {
  constructor(readonly code: GlimmerShopErrorCode, message: string) {
    super(message);
    this.name = "GlimmerShopError";
  }
}

type CatalogRow = {
  sku: string;
  kind: GlimmerShopKind;
  grant_item_id: string;
  grant_variant: string;
  price_glimmer: string;
  source: GlimmerShopSource | null;
  featured: boolean;
  on_sale: boolean;
  is_new: boolean;
  sort_order: number;
  added_at: Date;
};

const CATALOG_COLUMNS =
  "sku,kind,grant_item_id,grant_variant,price_glimmer::text,source,featured,on_sale,is_new,sort_order,added_at";
const JOINED_COLUMNS =
  "c.sku,c.kind,c.grant_item_id,c.grant_variant,c.price_glimmer::text AS price_glimmer,c.source,c.featured," +
  "c.on_sale,c.is_new,c.sort_order,c.added_at,d.display_name";

function catalogItem(row: CatalogRow, definitionName: string | null): GlimmerShopCatalogItem {
  const displayName = row.kind === "mask"
    ? faceMaskDisplayName(row.grant_variant)
    : row.kind === "manor_skin"
      ? manorSkinDisplayName(row.grant_variant)
      : definitionName ?? row.grant_item_id;
  return {
    sku: row.sku,
    kind: row.kind,
    grantItemId: row.grant_item_id,
    grantVariant: row.grant_variant,
    displayName,
    priceGlimmer: Number(row.price_glimmer),
    source: row.source,
    featured: row.featured,
    onSale: row.on_sale,
    isNew: row.is_new,
    sortOrder: row.sort_order,
    addedAt: row.added_at.toISOString()
  };
}

/** Sold in the shop: on sale and, for weapons/armour, not craft-only. */
function sellable(row: CatalogRow): boolean {
  return row.on_sale && row.source !== "craft";
}

/**
 * The Glimmer Shop (docs/design/GLIMMER_SHOP.md). One purchase = one transaction: the server
 * re-reads prices, mints every item through the inventory / equipment grant paths and debits the
 * premium wallet, all or nothing. Request ids replay per account and never charge twice.
 */
export class GlimmerShopService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: Readonly<{
      inventory: InventoryService;
      equipment: EquipmentService;
      premium: PremiumWalletService;
    }>
  ) {}

  /** On-sale items for players, plus the definitions whose Smithing recipe is shop-only. */
  async catalog(): Promise<GlimmerShopCatalogSnapshot> {
    const result = await this.pool.query<CatalogRow & { display_name: string | null }>(
      `SELECT ${JOINED_COLUMNS} FROM glimmer_shop_catalog c LEFT JOIN item_definitions d ON d.item_id=c.grant_item_id
       ORDER BY c.sort_order,c.sku`
    );
    return {
      items: result.rows.filter(sellable).map((row) => catalogItem(row, row.display_name)),
      shopOnlyDefinitionIds: result.rows
        .filter((row) => (row.kind === "weapon" || row.kind === "armour") && row.source === "shop")
        .map((row) => row.grant_item_id)
    };
  }

  /** Every catalog row (on sale or not) for the Developer App editor. */
  async adminCatalog(): Promise<readonly GlimmerShopCatalogItem[]> {
    const result = await this.pool.query<CatalogRow & { display_name: string | null }>(
      `SELECT ${JOINED_COLUMNS} FROM glimmer_shop_catalog c LEFT JOIN item_definitions d ON d.item_id=c.grant_item_id
       ORDER BY c.sort_order,c.sku`
    );
    return result.rows.map((row) => catalogItem(row, row.display_name));
  }

  /**
   * Admin edit of one row (price, source, featured, on sale, new, order). Writes one audit row with
   * the before/after state in the same transaction; the operation key replays.
   */
  async editCatalogItem(
    actorPlayerId: string,
    sku: string,
    edit: GlimmerShopCatalogEdit
  ): Promise<Readonly<{ item: GlimmerShopCatalogItem; replayed: boolean }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<CatalogRow & { display_name: string | null }>(
        `SELECT ${JOINED_COLUMNS} FROM glimmer_shop_catalog c LEFT JOIN item_definitions d ON d.item_id=c.grant_item_id
         WHERE c.sku=$1 FOR UPDATE OF c`,
        [sku]
      );
      const row = locked.rows[0];
      if (!row) throw new GlimmerShopError("SHOP_ITEM_UNAVAILABLE", "That catalog item does not exist.");
      const before = catalogItem(row, row.display_name);
      const previous = await client.query<{ sku: string }>(
        "SELECT sku FROM glimmer_shop_catalog_audit WHERE operation_key=$1", [edit.operationKey]
      );
      if (previous.rows[0]) {
        if (previous.rows[0].sku !== sku) {
          throw new GlimmerShopError("SHOP_IDEMPOTENCY_CONFLICT", "That operation key was already used for another item.");
        }
        await client.query("COMMIT");
        return { item: before, replayed: true };
      }
      if (edit.source !== undefined && row.kind !== "weapon" && row.kind !== "armour") {
        throw new GlimmerShopError("SHOP_INVALID_REQUEST", "Only weapons and armour have a craft/shop source.");
      }
      const updated = await client.query<CatalogRow>(
        `UPDATE glimmer_shop_catalog SET
           price_glimmer=$2, source=$3, featured=$4, on_sale=$5, is_new=$6, sort_order=$7,
           updated_at=now(), updated_by=$8
         WHERE sku=$1
         RETURNING ${CATALOG_COLUMNS}`,
        [
          sku,
          edit.priceGlimmer ?? before.priceGlimmer,
          edit.source ?? before.source,
          edit.featured ?? before.featured,
          edit.onSale ?? before.onSale,
          edit.isNew ?? before.isNew,
          edit.sortOrder ?? before.sortOrder,
          actorPlayerId
        ]
      );
      const after = catalogItem(updated.rows[0]!, row.display_name);
      await client.query(
        `INSERT INTO glimmer_shop_catalog_audit (operation_key,sku,actor_player_id,before,after)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [edit.operationKey, sku, actorPlayerId, JSON.stringify(before), JSON.stringify(after)]
      );
      await client.query("COMMIT");
      return { item: after, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async buy(playerId: string, input: BuyShopItemsInput): Promise<GlimmerShopPurchaseResult> {
    const { requestId, lines, expectedTotalGlimmer } = input;
    if (!requestId || requestId.length > 128) throw new GlimmerShopError("SHOP_INVALID_REQUEST", "A valid request ID is required.");
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > GLIMMER_SHOP_MAX_LINES) {
      throw new GlimmerShopError("SHOP_INVALID_REQUEST", `A purchase holds 1 to ${GLIMMER_SHOP_MAX_LINES} lines.`);
    }
    for (const line of lines) {
      if (typeof line.sku !== "string" || !GLIMMER_SHOP_SKU_PATTERN.test(line.sku) ||
        !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > GLIMMER_SHOP_MAX_QUANTITY) {
        throw new GlimmerShopError("SHOP_INVALID_REQUEST", `Each line buys 1 to ${GLIMMER_SHOP_MAX_QUANTITY} of one item.`);
      }
    }
    if (new Set(lines.map((line) => line.sku)).size !== lines.length) {
      throw new GlimmerShopError("SHOP_INVALID_REQUEST", "Each item may appear on one line only.");
    }
    if (!Number.isSafeInteger(expectedTotalGlimmer) || expectedTotalGlimmer <= 0) {
      throw new GlimmerShopError("SHOP_INVALID_REQUEST", "The expected total is invalid.");
    }
    const requestHash = createHash("sha256").update(JSON.stringify({
      lines: [...lines].map((line) => [line.sku, line.quantity]).sort(),
      expectedTotalGlimmer
    })).digest("hex");
    // Weapons are minted straight into equipment_instances: write any applied, unsaved kit first.
    await this.deps.equipment.flushPendingCheckpoint(playerId);
    const client = await this.pool.connect();
    let committedEquipment: GlimmerShopPurchaseResult["equipment"] | null = null;
    try {
      await client.query("BEGIN");
      const account = await client.query<{ account_id: string | null }>(
        "SELECT account_id::text FROM players WHERE id=$1", [playerId]
      );
      const accountId = account.rows[0]?.account_id;
      if (!accountId) throw new GlimmerShopError("SHOP_UNAVAILABLE", "Your account cannot buy from the shop right now.");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`glimmer-shop:${accountId}`]);
      const replay = await client.query<{ request_hash: string; player_id: string; total_glimmer: string; lines: GlimmerShopPurchaseLine[] }>(
        `SELECT request_hash,player_id,total_glimmer::text,lines FROM glimmer_shop_purchases
         WHERE account_id=$1 AND request_id=$2`,
        [accountId, requestId]
      );
      const previous = replay.rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash || previous.player_id !== playerId) {
          throw new GlimmerShopError("SHOP_IDEMPOTENCY_CONFLICT", "That request ID was already used for a different purchase.");
        }
        const result = await this.resultInTransaction(client, playerId, accountId, {
          requestId, replayed: true, totalGlimmer: Number(previous.total_glimmer), lines: previous.lines
        });
        await client.query("COMMIT");
        committedEquipment = result.equipment;
        return result;
      }

      // Lock the rows so an admin price edit cannot slip between the check and the debit.
      const catalog = await client.query<CatalogRow>(
        `SELECT ${CATALOG_COLUMNS} FROM glimmer_shop_catalog WHERE sku = ANY($1::text[]) FOR SHARE`,
        [lines.map((line) => line.sku)]
      );
      const bySku = new Map(catalog.rows.map((row) => [row.sku, row]));
      const priced: Array<GlimmerShopPurchaseLine & { row: CatalogRow }> = [];
      for (const line of lines) {
        const row = bySku.get(line.sku);
        if (!row || !sellable(row)) {
          throw new GlimmerShopError("SHOP_ITEM_UNAVAILABLE", "An item in your cart is no longer for sale. Refresh the shop.");
        }
        priced.push({ sku: row.sku, quantity: line.quantity, priceGlimmer: Number(row.price_glimmer), row });
      }
      const totalGlimmer = priced.reduce((total, line) => total + line.priceGlimmer * line.quantity, 0);
      if (totalGlimmer !== expectedTotalGlimmer) {
        throw new GlimmerShopError("SHOP_PRICE_CHANGED", "Prices changed. Refresh the shop and check your cart.");
      }
      const storedLines: GlimmerShopPurchaseLine[] = priced.map(({ sku, quantity, priceGlimmer }) => ({ sku, quantity, priceGlimmer }));
      await client.query(
        `INSERT INTO glimmer_shop_purchases (account_id,request_id,player_id,request_hash,total_glimmer,lines)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [accountId, requestId, playerId, requestHash, totalGlimmer, JSON.stringify(storedLines)]
      );

      const operationKey = `glimmer-shop:${accountId}:${requestId}`;
      const buyerRow = await client.query<{ username: string }>("SELECT username FROM players WHERE id=$1", [playerId]);
      const buyer = { playerId, name: (buyerRow.rows[0]?.username ?? "Unknown").slice(0, 80) };
      try {
        const itemGrants = priced.filter((line) => line.row.kind === "mask" || line.row.kind === "manor_skin");
        if (itemGrants.length > 0) {
          // Masks and Manor skins are per-copy items (1202): every unit is its own tagged copy.
          const copyGrants: Array<{ itemId: never; variant: string; quantity: number }> = [];
          for (const line of itemGrants) {
            const displayName = line.row.kind === "mask"
              ? faceMaskDisplayName(line.row.grant_variant)
              : manorSkinDisplayName(line.row.grant_variant);
            for (let unit = 0; unit < line.quantity; unit += 1) {
              const copyId = randomUUID();
              await insertShopCopy(client, {
                copyId, itemId: line.row.grant_item_id, look: line.row.grant_variant, displayName,
                buyer, accountId, requestId
              });
              copyGrants.push({ itemId: line.row.grant_item_id as never, variant: copyId, quantity: 1 });
            }
          }
          await this.deps.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `${operationKey}:items`,
            playerId,
            source: "glimmer_shop_purchase",
            sourceEntityType: "glimmer_shop_purchase",
            sourceEntityId: requestId,
            grants: copyGrants,
            metadata: { requestId, totalGlimmer }
          });
        }
        for (const line of priced.filter((entry) => entry.row.kind === "weapon" || entry.row.kind === "armour")) {
          const granted = await this.deps.equipment.grantPackageInstancesInTransaction(client, {
            operationKey: `${operationKey}:equipment:${line.sku}`,
            playerId,
            source: "glimmer_shop_purchase",
            grants: [{ definitionId: line.row.grant_item_id as EquipmentDefinitionId, quantity: line.quantity }]
          });
          if (granted.grants.some((grant) => grant.grantedQuantity < grant.requestedQuantity)) {
            throw new GlimmerShopError("SHOP_INVENTORY_FULL", "Your inventory is too full for this purchase. Make room and try again.");
          }
          const minted = await client.query<{ instance_id: string }>(
            "SELECT instance_id::text FROM equipment_instances WHERE created_by_operation_key=$1",
            [`${operationKey}:equipment:${line.sku}`]
          );
          for (const instance of minted.rows) {
            await insertShopCopy(client, {
              copyId: instance.instance_id, itemId: line.row.grant_item_id, look: "default", displayName: null,
              buyer, accountId, requestId
            });
          }
        }
      } catch (error) {
        if (isInventoryCapacityError(error)) {
          throw new GlimmerShopError("SHOP_INVENTORY_FULL", "Your inventory is too full for this purchase. Make room and try again.");
        }
        throw error;
      }

      let eventId: string;
      try {
        const debit = await this.deps.premium.debitForOperationInTransaction(client, {
          accountId,
          currency: "glimmer",
          amount: BigInt(totalGlimmer),
          operationKey,
          reason: "spend",
          actorPlayerId: playerId,
          refType: "glimmer_shop_purchase",
          refId: requestId,
          metadata: { requestId, lines: storedLines }
        });
        eventId = debit.eventId;
      } catch (error) {
        if (error instanceof PremiumWalletOperationError && error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
          throw new GlimmerShopError("SHOP_INSUFFICIENT_GLIMMER", `You need ${totalGlimmer.toLocaleString("en-US")} Glimmer.`);
        }
        throw error;
      }
      await client.query(
        "UPDATE glimmer_shop_purchases SET premium_event_id=$3 WHERE account_id=$1 AND request_id=$2",
        [accountId, requestId, eventId]
      );
      const result = await this.resultInTransaction(client, playerId, accountId, {
        requestId, replayed: false, totalGlimmer, lines: storedLines
      });
      await client.query("COMMIT");
      committedEquipment = result.equipment;
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof GlimmerShopError) throw error;
      if (isInventoryCapacityError(error) ||
        (error instanceof EquipmentError && error.code === "EQUIPMENT_INVENTORY_FULL")) {
        throw new GlimmerShopError("SHOP_INVENTORY_FULL", "Your inventory is too full for this purchase. Make room and try again.");
      }
      throw error;
    } finally {
      client.release();
      if (committedEquipment) this.deps.equipment.installAuthoritativeSnapshot(playerId, committedEquipment);
    }
  }

  private async resultInTransaction(
    client: pg.PoolClient,
    playerId: string,
    accountId: string,
    outcome: Readonly<{ requestId: string; replayed: boolean; totalGlimmer: number; lines: readonly GlimmerShopPurchaseLine[] }>
  ): Promise<GlimmerShopPurchaseResult> {
    const items = outcome.lines.reduce((total, line) => total + line.quantity, 0);
    return {
      ...outcome,
      message: outcome.replayed
        ? "Purchase already completed."
        : `Bought ${items} ${items === 1 ? "item" : "items"} for ${outcome.totalGlimmer.toLocaleString("en-US")} Glimmer.`,
      inventory: await this.deps.inventory.snapshotInTransaction(client, playerId),
      equipment: await this.deps.equipment.snapshotInTransaction(client, playerId),
      premiumWallet: await this.deps.premium.snapshotInTransaction(client, accountId)
    };
  }
}
