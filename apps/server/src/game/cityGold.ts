import {
  CITY_GOLD_CAPACITY,
  CITY_WAREHOUSE_INTERACTION_RADIUS_M,
  distanceMeters,
  type CityGoldSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  WalletOperationError,
  WalletService
} from "./wallet.js";

type Queryable = Pick<pg.PoolClient, "query">;
type Position = Readonly<{ lat: number; lon: number }>;

export type CityGoldErrorCode =
  | "CITY_GOLD_CAP_EXCEEDED"
  | "CITY_GOLD_INSUFFICIENT"
  | "CITY_GOLD_DONATION_INVALID"
  | "CITY_GOLD_ACCESS_DENIED"
  | "CITY_GOLD_IDEMPOTENCY_CONFLICT"
  | "CITY_GOLD_OPERATION_INCOMPLETE";

export class CityGoldError extends Error {
  constructor(
    readonly code: CityGoldErrorCode,
    message: string,
    readonly details?: Readonly<{
      currentBalance?: string;
      capacity?: string;
      remainingCapacity?: string;
    }>
  ) {
    super(message);
    this.name = "CityGoldError";
  }
}

export type CityGoldDonationResult = Readonly<{
  gold: CityGoldSnapshot;
  walletGold: string;
  walletVersion: string;
  replayed: boolean;
  donatedGold: string;
}>;

export class CityGoldService {
  private readonly wallet = new WalletService();

  constructor(private readonly pool: pg.Pool) {}

  async donate(
    playerId: string,
    warehouseStructureId: string,
    position: Position,
    requestId: string,
    amountRaw: string
  ): Promise<CityGoldDonationResult> {
    const amount = requirePositiveGold(amountRaw);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const warehouse = await client.query<{
        city_id: string;
        lat: number;
        lon: number;
      }>(
        `SELECT city_id::text, lat, lon
         FROM city_structures
         WHERE structure_id = $1
           AND structure_type = 'warehouse'
           AND state = 'active'
         FOR SHARE`,
        [warehouseStructureId]
      );
      const row = warehouse.rows[0];
      if (!row) {
        throw new CityGoldError(
          "CITY_GOLD_ACCESS_DENIED",
          "An active City Warehouse is required"
        );
      }
      const operationKey = `city-gold-donation:${playerId}:${requestId}`;
      const intent = {
        warehouseStructureId,
        cityId: row.city_id,
        amount: amount.toString()
      };
      const reservation = await client.query(
        `INSERT INTO city_gold_operations (
           operation_key, city_id, actor_player_id, request_id, action, intent
         ) VALUES ($1,$2,$3,$4,'donate',$5::jsonb)
         ON CONFLICT (actor_player_id, request_id) DO NOTHING
         RETURNING operation_key`,
        [
          operationKey,
          row.city_id,
          playerId,
          requestId,
          JSON.stringify(intent)
        ]
      );
      if (reservation.rowCount === 0) {
        const replay = await completedDonationReplay(
          client,
          playerId,
          requestId,
          intent
        );
        await client.query("COMMIT");
        return replay;
      }
      const access = await client.query(
        `SELECT 1
         FROM city_memberships membership
         JOIN cities city ON city.id = membership.city_id AND city.active
         WHERE membership.city_id = $1
           AND membership.player_id = $2
           AND membership.left_at IS NULL
         FOR SHARE OF membership, city`,
        [row.city_id, playerId]
      );
      if (access.rowCount !== 1) {
        throw new CityGoldError(
          "CITY_GOLD_ACCESS_DENIED",
          "Only an active member may donate Gold to this city"
        );
      }
      if (
        distanceMeters(position, { lat: row.lat, lon: row.lon }) >
        CITY_WAREHOUSE_INTERACTION_RADIUS_M
      ) {
        throw new CityGoldError(
          "CITY_GOLD_ACCESS_DENIED",
          "Move closer to the City Warehouse to donate Gold"
        );
      }
      const reserve = await lockReserve(client, row.city_id);
      const balance = BigInt(reserve.balance);
      const capacity = BigInt(CITY_GOLD_CAPACITY);
      const remaining = balance >= capacity ? 0n : capacity - balance;
      if (amount > remaining) {
        throw new CityGoldError(
          "CITY_GOLD_CAP_EXCEEDED",
          "The City Gold Reserve cannot accept that donation",
          {
            currentBalance: balance.toString(),
            capacity: capacity.toString(),
            remainingCapacity: remaining.toString()
          }
        );
      }
      let wallet;
      try {
        const account = await client.query<{ account_id: string }>(
          "SELECT account_id::text FROM players WHERE id = $1 FOR UPDATE",
          [playerId]
        );
        const accountId = account.rows[0]?.account_id;
        if (!accountId) {
          throw new CityGoldError(
            "CITY_GOLD_ACCESS_DENIED",
            "Authenticated player wallet is unavailable"
          );
        }
        wallet = await this.wallet.debitForOperationInTransaction(client, {
          playerId,
          accountId,
          amount,
          operationKey: `wallet:${operationKey}`,
          reason: "city_gold_donation",
          metadata: {
            cityId: row.city_id,
            warehouseStructureId
          }
        });
      } catch (error) {
        if (
          error instanceof WalletOperationError &&
          error.code === "WALLET_INSUFFICIENT_FUNDS"
        ) {
          throw new CityGoldError(
            "CITY_GOLD_INSUFFICIENT",
            "Your wallet does not contain enough Gold"
          );
        }
        throw error;
      }
      const updated = await client.query<{ balance: string }>(
        `UPDATE city_gold_reserves
         SET balance = balance + $2::bigint,
             lifetime_donated = lifetime_donated + $2::bigint,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE city_id = $1
         RETURNING balance::text`,
        [row.city_id, amount.toString()]
      );
      const balanceAfter = updated.rows[0]?.balance;
      if (balanceAfter === undefined) {
        throw new Error("City Gold reserve update failed");
      }
      await client.query(
        `INSERT INTO city_gold_ledger (
           operation_key, city_id, player_id, entry_type, delta,
           balance_after, source_type, source_id, metadata
         ) VALUES ($1,$2,$3,'member_donation',$4,$5,'warehouse',$6,$7::jsonb)`,
        [
          operationKey,
          row.city_id,
          playerId,
          amount.toString(),
          balanceAfter,
          warehouseStructureId,
          JSON.stringify({ requestId })
        ]
      );
      const gold = await this.snapshotInTransaction(
        client,
        row.city_id,
        playerId
      );
      const result: CityGoldDonationResult = {
        gold,
        walletGold: wallet.goldBalance.toString(),
        walletVersion: wallet.version.toString(),
        replayed: false,
        donatedGold: amount.toString()
      };
      await client.query(
        `UPDATE city_gold_operations
         SET result = $2::jsonb, completed_at = clock_timestamp()
         WHERE operation_key = $1`,
        [operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshot(
    cityId: string,
    playerId: string | null,
    canDonate = false
  ): Promise<CityGoldSnapshot> {
    const client = await this.pool.connect();
    try {
      return await this.snapshotInTransaction(
        client,
        cityId,
        canDonate ? playerId : null
      );
    } finally {
      client.release();
    }
  }

  async snapshotInTransaction(
    queryable: Queryable,
    cityId: string,
    donatingPlayerId: string | null
  ): Promise<CityGoldSnapshot> {
    const reserve = await queryable.query<{
      balance: string;
      lifetime_donated: string;
      lifetime_spent: string;
      revision: string;
    }>(
      `SELECT balance::text, lifetime_donated::text,
              lifetime_spent::text, revision::text
       FROM city_gold_reserves
       WHERE city_id = $1`,
      [cityId]
    );
    const row = reserve.rows[0] ?? {
      balance: "0",
      lifetime_donated: "0",
      lifetime_spent: "0",
      revision: "0"
    };
    const donations = await queryable.query<{
      player_id: string;
      username: string;
      amount: string;
      created_at: Date | string;
    }>(
      `SELECT ledger.player_id, player.username,
              ledger.delta::text AS amount, ledger.created_at
       FROM city_gold_ledger ledger
       JOIN players player ON player.id = ledger.player_id
       WHERE ledger.city_id = $1
         AND ledger.entry_type = 'member_donation'
       ORDER BY ledger.created_at DESC, ledger.entry_id DESC
       LIMIT 20`,
      [cityId]
    );
    const balance = BigInt(row.balance);
    const capacity = BigInt(CITY_GOLD_CAPACITY);
    return {
      balance: row.balance,
      capacity: capacity.toString(),
      remainingCapacity:
        balance >= capacity ? "0" : (capacity - balance).toString(),
      lifetimeDonated: row.lifetime_donated,
      lifetimeSpent: row.lifetime_spent,
      revision: row.revision,
      canDonate:
        donatingPlayerId !== null &&
        balance < capacity,
      recentDonations: donations.rows.map((donation) => ({
        playerId: donation.player_id,
        username: donation.username,
        amount: donation.amount,
        donatedAt: new Date(donation.created_at).toISOString()
      }))
    };
  }

  async spendForConstructionInTransaction(
    queryable: Queryable,
    input: Readonly<{
      cityId: string;
      actorPlayerId: string;
      requestId: string;
      operationKey: string;
      amount: bigint;
      structureId: string;
      sourceType: "market" | "monument";
      targetTier: 1 | 2 | 3;
    }>
  ): Promise<void> {
    if (input.amount <= 0n) {
      throw new CityGoldError(
        "CITY_GOLD_DONATION_INVALID",
        "City construction Gold must be positive"
      );
    }
    const reserve = await lockReserve(queryable, input.cityId);
    if (BigInt(reserve.balance) < input.amount) {
      throw new CityGoldError(
        "CITY_GOLD_INSUFFICIENT",
        "The City Gold Reserve does not contain enough Gold"
      );
    }
    await queryable.query(
      `INSERT INTO city_gold_operations (
         operation_key, city_id, actor_player_id, request_id, action, intent
       ) VALUES ($1,$2,$3,$4,'construction_spend',$5::jsonb)`,
      [
        input.operationKey,
        input.cityId,
        input.actorPlayerId,
        input.requestId,
        JSON.stringify({
          amount: input.amount.toString(),
          structureId: input.structureId,
          sourceType: input.sourceType,
          targetTier: input.targetTier
        })
      ]
    );
    const updated = await queryable.query<{ balance: string }>(
      `UPDATE city_gold_reserves
       SET balance = balance - $2::bigint,
           lifetime_spent = lifetime_spent + $2::bigint,
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE city_id = $1 AND balance >= $2::bigint
       RETURNING balance::text`,
      [input.cityId, input.amount.toString()]
    );
    const balanceAfter = updated.rows[0]?.balance;
    if (balanceAfter === undefined) {
      throw new CityGoldError(
        "CITY_GOLD_INSUFFICIENT",
        "The City Gold Reserve changed before construction spending"
      );
    }
    await queryable.query(
      `INSERT INTO city_gold_ledger (
         operation_key, city_id, player_id, entry_type, delta,
         balance_after, source_type, source_id, metadata
       ) VALUES ($1,$2,$3,'construction_spend',$4,$5,$6,$7,$8::jsonb)`,
      [
        input.operationKey,
        input.cityId,
        input.actorPlayerId,
        (-input.amount).toString(),
        balanceAfter,
        input.sourceType,
        input.structureId,
        JSON.stringify({ targetTier: input.targetTier })
      ]
    );
    await queryable.query(
      `UPDATE city_gold_operations
       SET result = $2::jsonb, completed_at = clock_timestamp()
       WHERE operation_key = $1`,
      [
        input.operationKey,
        JSON.stringify({
          balanceAfter,
          spentGold: input.amount.toString(),
          structureId: input.structureId
        })
      ]
    );
  }

  async refundConstructionInTransaction(
    queryable: Queryable,
    input: Readonly<{
      cityId: string;
      actorPlayerId: string;
      requestId: string;
      operationKey: string;
      amount: bigint;
      structureId: string;
      sourceType: "market" | "monument";
      targetTier: 1 | 2 | 3;
    }>
  ): Promise<void> {
    if (input.amount <= 0n) return;
    const existing = await queryable.query<{ result: { refundedGold?: string } | null }>(
      "SELECT result FROM city_gold_operations WHERE operation_key=$1",
      [input.operationKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].result?.refundedGold !== input.amount.toString()) {
        throw new CityGoldError(
          "CITY_GOLD_IDEMPOTENCY_CONFLICT",
          "City Gold refund key was reused with different intent"
        );
      }
      return;
    }
    await queryable.query(
      `INSERT INTO city_gold_operations (
         operation_key, city_id, actor_player_id, request_id, action, intent
       ) VALUES ($1,$2,$3,$4,'construction_refund',$5::jsonb)`,
      [
        input.operationKey,
        input.cityId,
        input.actorPlayerId,
        input.requestId,
        JSON.stringify({
          amount: input.amount.toString(),
          structureId: input.structureId,
          sourceType: input.sourceType,
          targetTier: input.targetTier
        })
      ]
    );
    const updated = await queryable.query<{ balance: string }>(
      `UPDATE city_gold_reserves
       SET balance = balance + $2::bigint,
           lifetime_spent = lifetime_spent - $2::bigint,
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE city_id = $1 AND lifetime_spent >= $2::bigint
       RETURNING balance::text`,
      [input.cityId, input.amount.toString()]
    );
    const balanceAfter = updated.rows[0]?.balance;
    if (balanceAfter === undefined) {
      throw new CityGoldError(
        "CITY_GOLD_OPERATION_INCOMPLETE",
        "City Gold construction refund could not be reconciled"
      );
    }
    await queryable.query(
      `INSERT INTO city_gold_ledger (
         operation_key, city_id, player_id, entry_type, delta,
         balance_after, source_type, source_id, metadata
       ) VALUES ($1,$2,$3,'construction_refund',$4,$5,$6,$7,$8::jsonb)`,
      [
        input.operationKey,
        input.cityId,
        input.actorPlayerId,
        input.amount.toString(),
        balanceAfter,
        input.sourceType,
        input.structureId,
        JSON.stringify({ targetTier: input.targetTier })
      ]
    );
    await queryable.query(
      `UPDATE city_gold_operations
       SET result = $2::jsonb, completed_at = clock_timestamp()
       WHERE operation_key = $1`,
      [
        input.operationKey,
        JSON.stringify({
          balanceAfter,
          refundedGold: input.amount.toString(),
          structureId: input.structureId
        })
      ]
    );
  }
}

async function lockReserve(
  queryable: Queryable,
  cityId: string
): Promise<{ balance: string }> {
  await queryable.query(
    `INSERT INTO city_gold_reserves (city_id)
     VALUES ($1) ON CONFLICT (city_id) DO NOTHING`,
    [cityId]
  );
  const result = await queryable.query<{ balance: string }>(
    `SELECT balance::text
     FROM city_gold_reserves
     WHERE city_id = $1
     FOR UPDATE`,
    [cityId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("City Gold reserve is unavailable");
  return row;
}

function requirePositiveGold(value: string): bigint {
  if (!/^[1-9]\d{0,18}$/u.test(value)) {
    throw new CityGoldError(
      "CITY_GOLD_DONATION_INVALID",
      "Gold donation must be a positive whole amount"
    );
  }
  const amount = BigInt(value);
  if (amount > 9_223_372_036_854_775_807n) {
    throw new CityGoldError(
      "CITY_GOLD_DONATION_INVALID",
      "Gold donation exceeds the supported amount"
    );
  }
  return amount;
}

async function completedDonationReplay(
  queryable: Queryable,
  playerId: string,
  requestId: string,
  intent: Readonly<Record<string, string>>
): Promise<CityGoldDonationResult> {
  const result = await queryable.query<{
    intent: Record<string, string>;
    result: CityGoldDonationResult | null;
  }>(
    `SELECT intent, result
     FROM city_gold_operations
     WHERE actor_player_id = $1 AND request_id = $2`,
    [playerId, requestId]
  );
  const row = result.rows[0];
  if (!row || JSON.stringify(row.intent) !== JSON.stringify(intent)) {
    throw new CityGoldError(
      "CITY_GOLD_IDEMPOTENCY_CONFLICT",
      "Request ID was already used for a different City Gold operation"
    );
  }
  if (!row.result) {
    throw new CityGoldError(
      "CITY_GOLD_OPERATION_INCOMPLETE",
      "The prior City Gold operation is incomplete"
    );
  }
  return { ...row.result, replayed: true };
}
