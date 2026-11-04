import { createHash, randomUUID } from "node:crypto";

import {
  DUNGEON_CATALOG,
  INVENTORY_CATALOG,
  LAMP_SHEATH_ITEM_ID,
  WANDERING_MERCHANT_GOODS,
  WANDERING_MERCHANT_GOODS_PER_VISIT,
  WANDERING_MERCHANT_INTERACTION_RADIUS_M,
  WANDERING_MERCHANT_MAX_LAMP_SHEATHS,
  WANDERING_MERCHANT_NAME,
  WANDERING_MERCHANT_OFFSET_M,
  WANDERING_MERCHANT_STAY_MS,
  destinationPoint,
  distanceMeters,
  lampSheathBasePrice,
  tradecraftMerchantDiscountPercent,
  wanderingMerchantUnitPrice,
  type LatLon,
  type PlayerInventorySnapshot,
  type ResourceType,
  type WanderingMerchantMapEntry,
  type WanderingMerchantShopSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { InventoryService } from "./inventory.js";
import type { WalletService } from "./wallet.js";

export class WanderingMerchantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WanderingMerchantError";
  }
}

type MerchantWallet = Pick<WalletService, "snapshot" | "debitForOperationInTransaction">;
type MerchantInventory = Pick<InventoryService, "grantItemsForOperationInTransaction">;
type Transaction = <T>(work: (client: pg.PoolClient) => Promise<T>) => Promise<T>;

export type WanderingMerchantDeps = Readonly<{
  pool: Pick<pg.Pool, "query">;
  wallet: MerchantWallet;
  inventory: MerchantInventory;
  transaction: Transaction;
  now?: () => number;
  /** Told when a merchant appears for a player so the client can show it without polling. */
  onSpawned?: (playerId: string) => void;
  logger?: Readonly<{ warn(context: object, message: string): void }>;
}>;

export type WanderingMerchantPlayer = Readonly<{ playerId: string; position: LatLon }>;

export type WanderingMerchantSpawnInput = Readonly<{
  playerId: string;
  /** Stable key for this completion; spawning twice with it never makes a second merchant. */
  spawnKey: string;
  dungeonId: string;
  dungeonName: string;
  entranceId: string;
  regionCode: string;
  entrance: LatLon;
}>;

export type WanderingMerchantPurchaseResult = Readonly<{
  replayed: boolean;
  itemId: string;
  quantity: number;
  totalGold: string;
  snapshot: WanderingMerchantShopSnapshot;
  inventory: PlayerInventorySnapshot;
  walletGold: string;
  walletVersion: string;
}>;

type MerchantRow = {
  merchant_id: string; owner_player_id: string; dungeon_id: string; entrance_id: string;
  region_code: string; lat: number | string; lon: number | string; expires_at: Date | string;
};
type StockRow = { item_id: string; base_price_gold: string | null; remaining: number | string };

const MERCHANT_COLUMNS = "merchant_id,owner_player_id,dungeon_id,entrance_id,region_code,lat,lon,expires_at";

/** Deterministic pick of `count` distinct goods from the pool, so a spawn key always rolls the same stock. */
export function rollMerchantGoods(spawnKey: string, count = WANDERING_MERCHANT_GOODS_PER_VISIT) {
  const ranked = WANDERING_MERCHANT_GOODS
    .map((good) => ({ good, rank: createHash("sha256").update(`${spawnKey}:${good.itemId}`).digest("hex") }))
    .sort((left, right) => left.rank.localeCompare(right.rank));
  return ranked.slice(0, Math.min(count, ranked.length)).map((entry) => entry.good);
}

/**
 * The Wandering Merchant: appears outside a dungeon after the player completes it, visible to and
 * buyable by that player only, for 30 minutes. Purchases debit gold and grant items in one
 * transaction keyed by the request id, so a replay never charges or grants twice.
 */
export class WanderingMerchantService {
  private readonly now: () => number;

  constructor(private readonly deps: WanderingMerchantDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Creates the merchant for a completion (idempotent). Returns its id, or null when one already existed. */
  async spawn(input: WanderingMerchantSpawnInput): Promise<string | null> {
    const merchantId = `wandering-merchant:${randomUUID()}`;
    const position = destinationPoint(input.entrance, WANDERING_MERCHANT_OFFSET_M, 90);
    const expiresAt = new Date(this.now() + WANDERING_MERCHANT_STAY_MS);
    const created = await this.deps.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO wandering_merchants
           (merchant_id,owner_player_id,spawn_key,dungeon_id,entrance_id,region_code,lat,lon,created_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (owner_player_id,spawn_key) DO NOTHING`,
        [merchantId, input.playerId, input.spawnKey, input.dungeonId, input.entranceId, input.regionCode,
          position.lat, position.lon, new Date(this.now()), expiresAt]
      );
      if ((inserted.rowCount ?? 0) === 0) return false;
      const goods = rollMerchantGoods(`${input.playerId}:${input.spawnKey}`);
      for (const good of goods) {
        await client.query(
          "INSERT INTO wandering_merchant_stock (merchant_id,item_id,base_price_gold,remaining) VALUES ($1,$2,$3,$4)",
          [merchantId, good.itemId, good.basePriceGold, good.stock]
        );
      }
      await client.query(
        "INSERT INTO wandering_merchant_stock (merchant_id,item_id,base_price_gold,remaining) VALUES ($1,$2,NULL,$3)",
        [merchantId, LAMP_SHEATH_ITEM_ID, WANDERING_MERCHANT_MAX_LAMP_SHEATHS]
      );
      return true;
    });
    if (!created) return null;
    this.deps.onSpawned?.(input.playerId);
    return merchantId;
  }

  /** The player's merchants that have not left yet, for the map. Never lists anyone else's. */
  async listActive(playerId: string): Promise<WanderingMerchantMapEntry[]> {
    const result = await this.deps.pool.query<MerchantRow & { dungeon_name?: string }>(
      `SELECT ${MERCHANT_COLUMNS} FROM wandering_merchants
        WHERE owner_player_id=$1 AND expires_at > $2 ORDER BY created_at,merchant_id`,
      [playerId, new Date(this.now())]
    );
    return result.rows.map((row) => ({
      merchantId: row.merchant_id,
      name: WANDERING_MERCHANT_NAME,
      dungeonName: dungeonDisplayName(row.dungeon_id),
      regionCode: row.region_code,
      lat: Number(row.lat),
      lon: Number(row.lon),
      expiresAt: new Date(row.expires_at).toISOString()
    }));
  }

  /** Removes merchants that have left. Safe to run on a timer. */
  async purgeExpired(): Promise<number> {
    const result = await this.deps.pool.query("DELETE FROM wandering_merchants WHERE expires_at <= $1", [new Date(this.now())]);
    return result.rowCount ?? 0;
  }

  async shopFor(player: WanderingMerchantPlayer, accountId: string, merchantId: string): Promise<WanderingMerchantShopSnapshot> {
    const merchant = await this.requireMerchantFor(player, merchantId);
    return this.snapshot(this.deps.pool, player.playerId, accountId, merchant);
  }

  async buy(player: WanderingMerchantPlayer, accountId: string, input: Readonly<{
    requestId: string; merchantId: string; itemId: string; quantity: number; expectedUnitPriceGold: string;
  }>): Promise<WanderingMerchantPurchaseResult> {
    if (!input.requestId) throw new WanderingMerchantError("MERCHANT_BAD_REQUEST", "A request id is required");
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new WanderingMerchantError("MERCHANT_INVALID_QUANTITY", "Purchase quantity must be a positive whole number");
    }
    const merchant = await this.requireMerchantFor(player, input.merchantId);
    const rank = await this.tradecraftRank(this.deps.pool, player.playerId);
    const stock = await this.stockLine(this.deps.pool, merchant.merchant_id, input.itemId);
    if (!stock) throw new WanderingMerchantError("MERCHANT_ITEM_UNAVAILABLE", "The merchant does not sell that");
    const unitPrice = await this.unitPrice(this.deps.pool, player.playerId, stock, rank);
    if (input.expectedUnitPriceGold !== String(unitPrice)) {
      throw new WanderingMerchantError("MERCHANT_PRICE_CHANGED", "The merchant's price changed");
    }
    const totalGold = BigInt(unitPrice) * BigInt(input.quantity);
    const operation = `wandering-merchant:${player.playerId}:${input.requestId}`;
    const done = await this.deps.transaction(async (client) => {
      // Lock the merchant row so expiry and stock changes serialise with this purchase.
      const locked = await client.query<MerchantRow>(
        `SELECT ${MERCHANT_COLUMNS} FROM wandering_merchants WHERE merchant_id=$1 FOR UPDATE`, [merchant.merchant_id]
      );
      const row = locked.rows[0];
      if (!row || row.owner_player_id !== player.playerId) {
        throw new WanderingMerchantError("MERCHANT_NOT_FOUND", "That merchant has moved on.");
      }
      if (new Date(row.expires_at).getTime() <= this.now()) {
        throw new WanderingMerchantError("MERCHANT_GONE", "The Wandering Merchant has left.");
      }
      const wallet = await this.deps.wallet.debitForOperationInTransaction(client, {
        playerId: player.playerId,
        accountId,
        amount: totalGold,
        operationKey: operation,
        reason: "wandering_merchant_purchase",
        metadata: { merchantId: merchant.merchant_id, itemId: input.itemId, quantity: input.quantity, rank }
      });
      if (wallet.applied) {
        const taken = await client.query(
          `UPDATE wandering_merchant_stock SET remaining=remaining-$3
            WHERE merchant_id=$1 AND item_id=$2 AND remaining>=$3`,
          [merchant.merchant_id, input.itemId, input.quantity]
        );
        if ((taken.rowCount ?? 0) === 0) {
          throw new WanderingMerchantError("MERCHANT_SOLD_OUT", "The merchant does not have that many left.");
        }
      }
      const granted = await this.deps.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `${operation}:items`,
        playerId: player.playerId,
        source: "wandering_merchant_purchase",
        sourceEntityType: "wandering_merchant",
        sourceEntityId: merchant.merchant_id,
        metadata: { itemId: input.itemId, quantity: input.quantity },
        grants: [{ itemId: input.itemId as ResourceType, variant: null, quantity: input.quantity }]
      });
      return { wallet, granted };
    });
    return {
      replayed: !done.wallet.applied,
      itemId: input.itemId,
      quantity: input.quantity,
      totalGold: totalGold.toString(),
      snapshot: await this.snapshot(this.deps.pool, player.playerId, accountId, merchant),
      inventory: done.granted.inventory,
      walletGold: done.wallet.goldBalance.toString(),
      walletVersion: done.wallet.version.toString()
    };
  }

  /** The merchant, only when it belongs to this player, has not left, and the player is close enough. */
  private async requireMerchantFor(player: WanderingMerchantPlayer, merchantId: string): Promise<MerchantRow> {
    const result = await this.deps.pool.query<MerchantRow>(
      `SELECT ${MERCHANT_COLUMNS} FROM wandering_merchants WHERE merchant_id=$1`, [merchantId]
    );
    const row = result.rows[0];
    // A stranger's merchant is indistinguishable from one that never existed.
    if (!row || row.owner_player_id !== player.playerId) {
      throw new WanderingMerchantError("MERCHANT_NOT_FOUND", "There is no merchant here for you.");
    }
    if (new Date(row.expires_at).getTime() <= this.now()) {
      throw new WanderingMerchantError("MERCHANT_GONE", "The Wandering Merchant has left.");
    }
    const position = { lat: Number(row.lat), lon: Number(row.lon) };
    if (distanceMeters(player.position, position) > WANDERING_MERCHANT_INTERACTION_RADIUS_M) {
      throw new WanderingMerchantError("MERCHANT_TOO_FAR", "Move closer to the Wandering Merchant.");
    }
    return row;
  }

  private async tradecraftRank(queryable: Pick<pg.Pool, "query">, playerId: string): Promise<number> {
    const result = await queryable.query<{ rank: number }>(
      "SELECT rank FROM player_skill_ranks WHERE player_id=$1 AND skill_id='tradecraft'", [playerId]
    );
    return Number(result.rows[0]?.rank ?? 0);
  }

  private async stockLine(queryable: Pick<pg.Pool, "query">, merchantId: string, itemId: string): Promise<StockRow | null> {
    const result = await queryable.query<StockRow>(
      "SELECT item_id,base_price_gold::text,remaining FROM wandering_merchant_stock WHERE merchant_id=$1 AND item_id=$2",
      [merchantId, itemId]
    );
    return result.rows[0] ?? null;
  }

  private async basePrice(queryable: Pick<pg.Pool, "query">, playerId: string, stock: StockRow): Promise<number> {
    if (stock.base_price_gold !== null) return Number(stock.base_price_gold);
    const level = await queryable.query<{ level: number | string }>(
      "SELECT level FROM player_progression_profiles WHERE player_id=$1", [playerId]
    );
    return lampSheathBasePrice(Number(level.rows[0]?.level ?? 1));
  }

  private async unitPrice(queryable: Pick<pg.Pool, "query">, playerId: string, stock: StockRow, rank: number): Promise<number> {
    return wanderingMerchantUnitPrice(await this.basePrice(queryable, playerId, stock), rank);
  }

  private async snapshot(
    queryable: Pick<pg.Pool, "query">,
    playerId: string,
    accountId: string,
    merchant: MerchantRow
  ): Promise<WanderingMerchantShopSnapshot> {
    const rank = await this.tradecraftRank(queryable, playerId);
    const stock = await queryable.query<StockRow>(
      "SELECT item_id,base_price_gold::text,remaining FROM wandering_merchant_stock WHERE merchant_id=$1 ORDER BY item_id",
      [merchant.merchant_id]
    );
    const wallet = await this.deps.wallet.snapshot(playerId, accountId);
    const lines = [];
    for (const row of stock.rows) {
      const base = await this.basePrice(queryable, playerId, row);
      lines.push({
        itemId: row.item_id,
        displayName: INVENTORY_CATALOG[row.item_id as keyof typeof INVENTORY_CATALOG]?.displayName ?? row.item_id,
        baseUnitPriceGold: String(base),
        unitPriceGold: String(wanderingMerchantUnitPrice(base, rank)),
        remaining: Number(row.remaining)
      });
    }
    // Lamp Sheaths first: they are what people come for.
    lines.sort((left, right) => Number(right.itemId === LAMP_SHEATH_ITEM_ID) - Number(left.itemId === LAMP_SHEATH_ITEM_ID));
    return {
      merchantId: merchant.merchant_id,
      name: WANDERING_MERCHANT_NAME,
      dungeonName: dungeonDisplayName(merchant.dungeon_id),
      expiresAt: new Date(merchant.expires_at).toISOString(),
      rank,
      discountPercent: tradecraftMerchantDiscountPercent(rank),
      walletGold: wallet.gold,
      lines
    };
  }
}

function dungeonDisplayName(dungeonId: string): string {
  const named = DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === dungeonId)?.name;
  if (named) return named;
  return dungeonId.replace(/_/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
