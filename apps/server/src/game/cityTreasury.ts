import type { CityContributionEntry } from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type CityTreasurySnapshot = {
  balance: string;
  lifetimeEarned: string;
  lifetimeSpent: string;
};

export type ActiveCityMembership = Readonly<{
  membershipId: string;
  cityId: string;
  cityName: string;
}>;

export type CityContributionCreditInput = Readonly<{
  operationKey: string;
  cityId: string;
  playerId: string;
  membershipId: string;
  amount: number;
  sourceType: "combat_settlement" | "development_grant" | "player_package" | "market_daily_package";
  sourceId: string;
  ledgerEntryType:
    | "combat_contribution"
    | "development_grant"
    | "package_grant"
    | "market_daily_package";
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type CityContributionOperation = Readonly<{
  cityId: string;
  cityName: string;
  playerId: string;
  membershipId: string;
}>;

export class CityTreasuryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CityTreasuryError";
  }
}

export class CityTreasuryService {
  constructor(private readonly pool: pg.Pool) {}

  async snapshot(cityId: string, queryable: Queryable = this.pool): Promise<CityTreasurySnapshot> {
    await queryable.query(
      "INSERT INTO city_treasuries (city_id) VALUES ($1) ON CONFLICT (city_id) DO NOTHING",
      [cityId]
    );
    const result = await queryable.query<{
      balance: string;
      lifetime_earned: string;
      lifetime_spent: string;
    }>(
      `SELECT balance::text, lifetime_earned::text, lifetime_spent::text
       FROM city_treasuries WHERE city_id=$1`,
      [cityId]
    );
    const row = result.rows[0]!;
    return {
      balance: row.balance,
      lifetimeEarned: row.lifetime_earned,
      lifetimeSpent: row.lifetime_spent
    };
  }

  async creditCombatInTransaction(
    client: pg.PoolClient,
    input: {
      operationKey: string;
      cityId: string;
      playerId: string;
      membershipId: string;
      amount: number;
      settlementKey: string;
      mobArchetype: string;
    }
  ): Promise<{ applied: boolean; balance: string; contribution: string }> {
    return this.creditContributionInTransaction(client, {
      operationKey: input.operationKey,
      cityId: input.cityId,
      playerId: input.playerId,
      membershipId: input.membershipId,
      amount: input.amount,
      sourceType: "combat_settlement",
      sourceId: input.settlementKey,
      ledgerEntryType: "combat_contribution",
      metadata: { mobArchetype: input.mobArchetype }
    });
  }

  async activeMembershipForPlayerInTransaction(
    client: pg.PoolClient,
    playerId: string
  ): Promise<ActiveCityMembership | null> {
    const result = await client.query<{
      membership_id: string;
      city_id: string;
      city_name: string;
    }>(
      `SELECT membership.membership_id::text,
              membership.city_id::text,
              city.name AS city_name
       FROM city_memberships membership
       JOIN cities city ON city.id=membership.city_id AND city.active
       WHERE membership.player_id=$1 AND membership.left_at IS NULL
       ORDER BY membership.joined_at DESC,membership.membership_id
       LIMIT 1
       FOR SHARE OF membership,city`,
      [playerId]
    );
    const row = result.rows[0];
    return row
      ? {
          membershipId: row.membership_id,
          cityId: row.city_id,
          cityName: row.city_name
        }
      : null;
  }

  async contributionOperationInTransaction(
    client: pg.PoolClient,
    operationKey: string
  ): Promise<CityContributionOperation | null> {
    const result = await client.query<{
      city_id: string;
      city_name: string;
      player_id: string;
      membership_id: string;
    }>(
      `SELECT ledger.city_id::text,
              city.name AS city_name,
              ledger.player_id,
              ledger.membership_id::text
       FROM city_coin_ledger ledger
       JOIN cities city ON city.id=ledger.city_id
       WHERE ledger.operation_key=$1`,
      [operationKey]
    );
    const row = result.rows[0];
    return row
      ? {
          cityId: row.city_id,
          cityName: row.city_name,
          playerId: row.player_id,
          membershipId: row.membership_id
        }
      : null;
  }

  async creditContributionInTransaction(
    client: pg.PoolClient,
    input: CityContributionCreditInput
  ): Promise<{ applied: boolean; balance: string; contribution: string }> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new CityTreasuryError(
        "CITY_COIN_AMOUNT_INVALID",
        "City Coin credit must be a positive whole number"
      );
    }
    if (
      !input.operationKey ||
      !input.cityId ||
      !input.playerId ||
      !input.membershipId ||
      !input.sourceId
    ) {
      throw new CityTreasuryError(
        "CITY_COIN_CREDIT_INVALID",
        "City Coin contribution identity is incomplete"
      );
    }
    await client.query(
      "INSERT INTO city_treasuries (city_id) VALUES ($1) ON CONFLICT (city_id) DO NOTHING",
      [input.cityId]
    );
    const existing = await client.query<{
      city_id: string;
      player_id: string | null;
      membership_id: string | null;
      delta: string;
      entry_type: string;
      source_type: string;
      source_id: string;
    }>(
      `SELECT city_id::text,player_id,membership_id::text,delta::text,
              entry_type,source_type,source_id
       FROM city_coin_ledger
       WHERE operation_key=$1`,
      [input.operationKey]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (
        row.city_id !== input.cityId ||
        row.player_id !== input.playerId ||
        row.membership_id !== input.membershipId ||
        BigInt(row.delta) !== BigInt(input.amount) ||
        row.entry_type !== input.ledgerEntryType ||
        row.source_type !== input.sourceType ||
        row.source_id !== input.sourceId
      ) {
        throw new CityTreasuryError(
          "CITY_COIN_IDEMPOTENCY_CONFLICT",
          "City Coin operation key was reused with different intent"
        );
      }
      return this.creditResult(client, input.cityId, input.playerId, false);
    }
    const treasury = await client.query<{ balance: string }>(
      `UPDATE city_treasuries
       SET balance=balance+$2::bigint,
           lifetime_earned=lifetime_earned+$2::bigint,
           revision=revision+1,
           updated_at=now()
       WHERE city_id=$1
       RETURNING balance::text`,
      [input.cityId, input.amount]
    );
    await client.query(
      `INSERT INTO city_coin_ledger (
         operation_key, city_id, player_id, membership_id, entry_type,
         delta, balance_after, source_type, source_id, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8,$9,$10::jsonb)`,
      [
        input.operationKey,
        input.cityId,
        input.playerId,
        input.membershipId,
        input.ledgerEntryType,
        input.amount,
        treasury.rows[0]!.balance,
        input.sourceType,
        input.sourceId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    await client.query(
      `INSERT INTO city_coin_contributions (
         city_id,player_id,lifetime_contributed,first_contributed_at,last_contributed_at
       ) VALUES ($1,$2,$3::bigint,now(),now())
       ON CONFLICT (city_id,player_id) DO UPDATE
       SET lifetime_contributed=city_coin_contributions.lifetime_contributed+$3::bigint,
           last_contributed_at=now()`,
      [input.cityId, input.playerId, input.amount]
    );
    return this.creditResult(client, input.cityId, input.playerId, true);
  }

  async spendInTransaction(
    client: pg.PoolClient,
    input: {
      operationKey: string;
      cityId: string;
      actorPlayerId: string;
      amount: number;
      sourceId: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ applied: boolean; balance: string }> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new CityTreasuryError("CITY_COIN_AMOUNT_INVALID", "City Coin spend must be positive");
    }
    await client.query(
      "INSERT INTO city_treasuries (city_id) VALUES ($1) ON CONFLICT (city_id) DO NOTHING",
      [input.cityId]
    );
    const existing = await client.query<{ city_id: string; delta: string; balance_after: string }>(
      "SELECT city_id,delta::text,balance_after::text FROM city_coin_ledger WHERE operation_key=$1",
      [input.operationKey]
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].city_id !== input.cityId ||
        BigInt(existing.rows[0].delta) !== -BigInt(input.amount)
      ) {
        throw new CityTreasuryError(
          "CITY_COIN_IDEMPOTENCY_CONFLICT",
          "City Coin operation key was reused with different intent"
        );
      }
      return { applied: false, balance: existing.rows[0].balance_after };
    }
    const updated = await client.query<{ balance: string }>(
      `UPDATE city_treasuries
       SET balance=balance-$2::bigint,
           lifetime_spent=lifetime_spent+$2::bigint,
           revision=revision+1,
           updated_at=now()
       WHERE city_id=$1 AND balance >= $2::bigint
       RETURNING balance::text`,
      [input.cityId, input.amount]
    );
    if (!updated.rows[0]) {
      throw new CityTreasuryError(
        "CITY_TREASURY_INSUFFICIENT",
        `The city treasury needs ${input.amount.toLocaleString()} City Coins`
      );
    }
    await client.query(
      `INSERT INTO city_coin_ledger (
         operation_key,city_id,player_id,entry_type,delta,balance_after,
         source_type,source_id,metadata
       ) VALUES ($1,$2,$3,'construction_spend',$4::bigint,$5::bigint,
                 'city_construction',$6,$7::jsonb)`,
      [
        input.operationKey,
        input.cityId,
        input.actorPlayerId,
        -input.amount,
        updated.rows[0].balance,
        input.sourceId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return { applied: true, balance: updated.rows[0].balance };
  }

  async refundConstructionInTransaction(
    client: pg.PoolClient,
    input: {
      operationKey: string;
      cityId: string;
      actorPlayerId: string;
      amount: number;
      sourceId: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ applied: boolean; balance: string }> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new CityTreasuryError("CITY_COIN_AMOUNT_INVALID", "City Coin refund must be positive");
    }
    const existing = await client.query<{ city_id: string; delta: string; balance_after: string }>(
      "SELECT city_id,delta::text,balance_after::text FROM city_coin_ledger WHERE operation_key=$1",
      [input.operationKey]
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].city_id !== input.cityId ||
        BigInt(existing.rows[0].delta) !== BigInt(input.amount)
      ) {
        throw new CityTreasuryError(
          "CITY_COIN_IDEMPOTENCY_CONFLICT",
          "City Coin refund key was reused with different intent"
        );
      }
      return { applied: false, balance: existing.rows[0].balance_after };
    }
    const updated = await client.query<{ balance: string }>(
      `UPDATE city_treasuries
       SET balance=balance+$2::bigint,
           lifetime_spent=lifetime_spent-$2::bigint,
           revision=revision+1,
           updated_at=now()
       WHERE city_id=$1 AND lifetime_spent >= $2::bigint
       RETURNING balance::text`,
      [input.cityId, input.amount]
    );
    if (!updated.rows[0]) {
      throw new CityTreasuryError(
        "CITY_TREASURY_REFUND_INVALID",
        "City Coin construction refund could not be reconciled"
      );
    }
    await client.query(
      `INSERT INTO city_coin_ledger (
         operation_key,city_id,player_id,entry_type,delta,balance_after,
         source_type,source_id,metadata
       ) VALUES ($1,$2,$3,'construction_refund',$4::bigint,$5::bigint,
                 'city_construction',$6,$7::jsonb)`,
      [
        input.operationKey,
        input.cityId,
        input.actorPlayerId,
        input.amount,
        updated.rows[0].balance,
        input.sourceId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return { applied: true, balance: updated.rows[0].balance };
  }

  async leaderboard(
    cityId: string,
    viewingPlayerId: string
  ): Promise<{ entries: CityContributionEntry[]; own: CityContributionEntry | null }> {
    const result = await this.pool.query<{
      rank: string;
      player_id: string;
      username: string;
      contributed: string;
      current_member: boolean;
      top_entry: boolean;
    }>(
      `WITH ranked AS (
         SELECT contribution.player_id,
                player.username,
                contribution.lifetime_contributed,
                rank() OVER (
                  ORDER BY contribution.lifetime_contributed DESC,
                           contribution.first_contributed_at ASC,
                           contribution.player_id ASC
                ) AS rank,
                EXISTS (
                  SELECT 1 FROM city_memberships membership
                  WHERE membership.city_id=contribution.city_id
                    AND membership.player_id=contribution.player_id
                    AND membership.left_at IS NULL
                ) AS current_member
         FROM city_coin_contributions contribution
         JOIN players player ON player.id=contribution.player_id
         WHERE contribution.city_id=$1
       )
       SELECT rank::text,player_id,username,lifetime_contributed::text AS contributed,
              current_member,(rank <= 25) AS top_entry
       FROM ranked
       WHERE rank <= 25 OR player_id=$2
       ORDER BY rank,player_id`,
      [cityId, viewingPlayerId]
    );
    const mapped = result.rows.map((row) => ({
      rank: Number(row.rank),
      playerId: row.player_id,
      username: row.username,
      contributed: row.contributed,
      currentMember: row.current_member
    }));
    return {
      entries: result.rows.flatMap((row, index) => row.top_entry ? [mapped[index]!] : []),
      own: mapped.find((entry) => entry.playerId === viewingPlayerId) ?? null
    };
  }

  private async creditResult(
    client: pg.PoolClient,
    cityId: string,
    playerId: string,
    applied: boolean
  ): Promise<{ applied: boolean; balance: string; contribution: string }> {
    const result = await client.query<{ balance: string; contribution: string }>(
      `SELECT treasury.balance::text,
              COALESCE(contribution.lifetime_contributed,0)::text AS contribution
       FROM city_treasuries treasury
       LEFT JOIN city_coin_contributions contribution
         ON contribution.city_id=treasury.city_id AND contribution.player_id=$2
       WHERE treasury.city_id=$1`,
      [cityId, playerId]
    );
    return { applied, ...result.rows[0]! };
  }
}
