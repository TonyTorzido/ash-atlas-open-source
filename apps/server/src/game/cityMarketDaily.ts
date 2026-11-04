import {
  cityMarketDailyPackage,
  cityMarketLevel,
  type CityMarketDailySnapshot,
  type CityMonumentTier,
  type PremiumWalletSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { CityTreasuryService } from "./cityTreasury.js";
import { PremiumWalletOperationError, PremiumWalletService } from "./premiumWallet.js";

export class CityMarketDailyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CityMarketDailyError";
  }
}

export type CityMarketDailyPurchaseResult = Readonly<{
  cityId: string;
  marketDaily: CityMarketDailySnapshot;
  treasuryBalance: string;
  premiumWallet: PremiumWalletSnapshot;
  replayed: boolean;
}>;

type Queryable = Pick<pg.PoolClient, "query">;

/** UTC calendar day; the daily limit resets at 00:00 UTC. */
export function cityMarketDailyDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * City Market "Daily offer". Glimmer (our premium currency) buys one package of City Coins per player per UTC day; the coins
 * go into the city treasury. The City Market level (`cityMarketLevel`) picks the
 * package; a Market mid-upgrade sells at its previous level. One
 * transaction holds the player row, the (player, day) gate, the Glimmer debit
 * and the treasury credit, so a duplicate or concurrent request can only ever
 * apply once.
 */
export class CityMarketDailyService {
  private readonly premium = new PremiumWalletService();

  constructor(
    private readonly pool: pg.Pool,
    private readonly treasury: CityTreasuryService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async snapshotInTransaction(
    queryable: Queryable,
    cityId: string,
    playerId: string
  ): Promise<CityMarketDailySnapshot | null> {
    const market = await queryable.query<{ structure_id: string; market_level: number }>(
      `SELECT structure_id::text, CASE WHEN state='active' THEN tier ELSE tier - 1 END AS market_level
       FROM city_structures
       WHERE city_id=$1::uuid AND structure_type='market' AND state IN ('active','constructing')
       ORDER BY state, built_at DESC, structure_id LIMIT 1`,
      [cityId]
    );
    const row = market.rows[0];
    const marketLevel = cityMarketLevel(Number(row?.market_level ?? 0));
    if (!row || marketLevel < 1) return null;
    const day = cityMarketDailyDay(this.now());
    const bought = await queryable.query(
      "SELECT 1 FROM city_market_daily_purchases WHERE player_id=$1 AND purchase_day=$2::date",
      [playerId, day]
    );
    const pack = cityMarketDailyPackage(marketLevel);
    return {
      marketStructureId: row.structure_id,
      marketLevel,
      tier: pack.tier as CityMonumentTier,
      cityCoins: pack.cityCoins,
      glimmer: pack.glimmer,
      day,
      purchasedToday: (bought.rowCount ?? 0) > 0
    };
  }

  async snapshot(cityId: string, playerId: string): Promise<CityMarketDailySnapshot | null> {
    const client = await this.pool.connect();
    try {
      return await this.snapshotInTransaction(client, cityId, playerId);
    } finally {
      client.release();
    }
  }

  async purchase(playerId: string, cityId: string, requestId: string): Promise<CityMarketDailyPurchaseResult> {
    const operationKey = `city-market-daily:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const player = await client.query<{ account_id: string }>(
        "SELECT account_id FROM players WHERE id=$1 FOR UPDATE",
        [playerId]
      );
      const accountId = player.rows[0]?.account_id;
      if (!accountId) throw new CityMarketDailyError("CITY_MARKET_DAILY_DENIED", "Player account is unavailable");

      const replay = await client.query<{ city_id: string }>(
        "SELECT city_id::text FROM city_market_daily_purchases WHERE operation_key=$1",
        [operationKey]
      );
      if (replay.rows[0]) {
        if (replay.rows[0].city_id !== cityId) {
          throw new CityMarketDailyError(
            "CITY_MARKET_DAILY_IDEMPOTENCY_CONFLICT",
            "That request id was already used for a different city"
          );
        }
        const result = await this.result(client, cityId, playerId, accountId, true);
        await client.query("COMMIT");
        return result;
      }

      const membership = await client.query<{ membership_id: string }>(
        `SELECT membership.membership_id::text
         FROM city_memberships membership
         JOIN cities city ON city.id=membership.city_id AND city.active
         WHERE membership.city_id=$1::uuid AND membership.player_id=$2 AND membership.left_at IS NULL
         FOR SHARE OF membership, city`,
        [cityId, playerId]
      );
      const membershipId = membership.rows[0]?.membership_id;
      if (!membershipId) {
        throw new CityMarketDailyError("CITY_MARKET_DAILY_DENIED", "Only an active member can buy the City Market's daily package");
      }
      const market = await this.snapshotInTransaction(client, cityId, playerId);
      if (!market) {
        throw new CityMarketDailyError("CITY_MARKET_DAILY_UNAVAILABLE", "This city has no active City Market");
      }
      if (market.purchasedToday) {
        throw new CityMarketDailyError(
          "CITY_MARKET_DAILY_ALREADY_PURCHASED",
          "You already bought today's package. It resets at 00:00 UTC."
        );
      }
      // The (player, day) primary key is the race-proof gate; the check above is the friendly error.
      const inserted = await client.query(
        `INSERT INTO city_market_daily_purchases (
           player_id, purchase_day, request_id, operation_key, city_id,
           market_structure_id, tier, city_coins, glimmer_cost
         ) VALUES ($1,$2::date,$3,$4,$5::uuid,$6::uuid,$7,$8,$9)
         ON CONFLICT DO NOTHING`,
        [playerId, market.day, requestId, operationKey, cityId, market.marketStructureId,
          market.tier, market.cityCoins, market.glimmer]
      );
      if (inserted.rowCount !== 1) {
        throw new CityMarketDailyError(
          "CITY_MARKET_DAILY_ALREADY_PURCHASED",
          "You already bought today's package. It resets at 00:00 UTC."
        );
      }
      try {
        await this.premium.debitForOperationInTransaction(client, {
          accountId,
          currency: "glimmer",
          amount: BigInt(market.glimmer),
          operationKey,
          reason: "spend",
          actorPlayerId: playerId,
          refType: "city_market_daily",
          refId: cityId,
          metadata: { cityId, tier: market.tier, cityCoins: market.cityCoins, day: market.day }
        });
      } catch (error) {
        if (error instanceof PremiumWalletOperationError && error.code === "PREMIUM_WALLET_INSUFFICIENT_FUNDS") {
          throw new CityMarketDailyError(
            "CITY_MARKET_DAILY_INSUFFICIENT_GLIMMER",
            `You need ${market.glimmer} Glimmer for this package`
          );
        }
        throw error;
      }
      await this.treasury.creditContributionInTransaction(client as pg.PoolClient, {
        operationKey,
        cityId,
        playerId,
        membershipId,
        amount: market.cityCoins,
        sourceType: "market_daily_package",
        sourceId: market.marketStructureId,
        ledgerEntryType: "market_daily_package",
        metadata: { tier: market.tier, glimmer: market.glimmer, day: market.day }
      });
      const result = await this.result(client, cityId, playerId, accountId, false);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async result(
    client: pg.PoolClient,
    cityId: string,
    playerId: string,
    accountId: string,
    replayed: boolean
  ): Promise<CityMarketDailyPurchaseResult> {
    const marketDaily = await this.snapshotInTransaction(client, cityId, playerId);
    if (!marketDaily) {
      throw new CityMarketDailyError("CITY_MARKET_DAILY_UNAVAILABLE", "This city has no active City Market");
    }
    const treasury = await this.treasury.snapshot(cityId, client);
    return {
      cityId,
      marketDaily,
      treasuryBalance: treasury.balance,
      premiumWallet: await this.premium.snapshotInTransaction(client, accountId),
      replayed
    };
  }
}
