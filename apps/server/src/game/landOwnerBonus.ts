import { createHash } from "node:crypto";

import {
  CITY_GOLD_CAPACITY,
  landOwnerBonusExact,
  type LandBonusPayeeKind
} from "@ash-atlas/shared";
import type pg from "pg";

import { MAX_FLAG_CLAIM_RADIUS_M } from "../config.js";
import type { WalletService } from "./wallet.js";

type LandBonusWallet = Pick<WalletService, "creditForOperationInTransaction">;
type Position = Readonly<{ lat: number; lon: number }>;

export type LandBonusPayout = Readonly<{
  payeeKind: LandBonusPayeeKind;
  /** Player id, city id or kingdom id, by payeeKind. */
  payeeId: string;
  flagId: string;
  killGold: number;
  /** Gold actually minted; below the 5% bonus only when a City Gold Reserve cap clamped it. */
  paidGold: number;
  /** Personal flags only: the owner's wallet after the credit, for the owner's notification. */
  walletGold?: string;
  walletVersion?: string;
}>;

type LandRow = {
  flag_id: string;
  control_type: string;
  owner_id: string;
  city_id: string | null;
  kingdom_id: string | null;
};

/** Deterministic per-settlement rounding so the expected bonus is exactly 5% even on tiny kills. */
export function landOwnerBonusGold(killGold: number, settlementKey: string): number {
  const exact = landOwnerBonusExact(killGold);
  const whole = Math.floor(exact);
  const fraction = exact - whole;
  if (fraction === 0) return whole;
  const digest = createHash("sha256").update(`land-owner-bonus-v1:${settlementKey}`).digest();
  const unit = digest.readUInt32BE(0) / 0x1_0000_0000;
  return whole + (unit < fraction ? 1 : 0);
}

/**
 * Pays the owner of the land a kill happened on 4% of the kill's gold, minted
 * in the hunter's own reward transaction (the hunter's reward is untouched).
 * Returns null when no one is owed: no gold, no standing claim, the hunter is
 * the owner (or a member of the owning city / kingdom), or this settlement
 * already paid. Keyed by settlement, so a replay never pays twice.
 */
export async function creditLandOwnerBonusInTransaction(
  client: pg.PoolClient,
  wallet: LandBonusWallet,
  input: Readonly<{
    settlementKey: string;
    hunterPlayerId: string;
    position: Position;
    killGold: number;
  }>
): Promise<LandBonusPayout | null> {
  const bonus = landOwnerBonusGold(input.killGold, input.settlementKey);
  if (bonus <= 0) return null;
  if (!Number.isFinite(input.position.lat) || !Number.isFinite(input.position.lon)) return null;
  const done = await client.query(
    "SELECT 1 FROM land_owner_bonus_payouts WHERE settlement_key=$1",
    [input.settlementKey]
  );
  if (done.rowCount) return null;

  const land = await client.query<LandRow>(
    `WITH point AS (
       SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS g
     )
     SELECT f.id::text AS flag_id, f.control_type, f.owner_id,
            f.city_id::text AS city_id, f.kingdom_id::text AS kingdom_id
     FROM flags f
     LEFT JOIN kingdom_seats seat
       ON f.control_type = 'kingdom_seat' AND seat.source_flag_id = f.id AND seat.status = 'active'
     CROSS JOIN point
     WHERE f.anchor_kind = 'flag'
       AND NOT f.system_controlled
       AND f.territory_collapse_id IS NULL
       AND ST_DWithin(f.geom::geography, point.g, $3)
       AND ST_DWithin(
         COALESCE(seat.geom, f.geom)::geography,
         point.g,
         COALESCE(seat.territory_radius_m, f.claim_radius_m)
       )
     ORDER BY ST_Distance(COALESCE(seat.geom, f.geom)::geography, point.g), f.id
     LIMIT 1`,
    [input.position.lat, input.position.lon, MAX_FLAG_CLAIM_RADIUS_M + 1_000]
  );
  const flag = land.rows[0];
  if (!flag) return null;

  const operationKey = `land-bonus:${input.settlementKey}`;
  const metadata = { settlementKey: input.settlementKey, flagId: flag.flag_id, killGold: input.killGold };
  let payout: LandBonusPayout;

  if (flag.control_type === "personal") {
    if (flag.owner_id === input.hunterPlayerId) return null;
    const owner = await client.query<{ account_id: string }>(
      "SELECT account_id FROM players WHERE id=$1 FOR SHARE",
      [flag.owner_id]
    );
    const accountId = owner.rows[0]?.account_id;
    if (!accountId) return null;
    const credit = await wallet.creditForOperationInTransaction(client, {
      playerId: flag.owner_id,
      accountId,
      amount: BigInt(bonus),
      operationKey,
      reason: "land_owner_hunting_bonus_reward",
      metadata: { ...metadata, hunterPlayerId: input.hunterPlayerId }
    });
    payout = {
      payeeKind: "player",
      payeeId: flag.owner_id,
      flagId: flag.flag_id,
      killGold: input.killGold,
      paidGold: bonus,
      walletGold: credit.goldBalance.toString(),
      walletVersion: credit.version.toString()
    };
  } else if (flag.control_type === "city" || flag.control_type === "city_seat") {
    if (!flag.city_id) return null;
    const member = await client.query(
      `SELECT 1 FROM city_memberships
       WHERE city_id=$1::uuid AND player_id=$2 AND left_at IS NULL`,
      [flag.city_id, input.hunterPlayerId]
    );
    if (member.rowCount) return null;
    const city = await client.query("SELECT 1 FROM cities WHERE id=$1::uuid AND active FOR SHARE", [flag.city_id]);
    if (!city.rowCount) return null;
    await client.query(
      "INSERT INTO city_gold_reserves (city_id) VALUES ($1::uuid) ON CONFLICT (city_id) DO NOTHING",
      [flag.city_id]
    );
    const reserve = await client.query<{ balance: string }>(
      "SELECT balance::text FROM city_gold_reserves WHERE city_id=$1::uuid FOR UPDATE",
      [flag.city_id]
    );
    const remaining = Math.max(0, CITY_GOLD_CAPACITY - Number(reserve.rows[0]?.balance ?? 0));
    const paid = Math.min(bonus, remaining);
    if (paid > 0) {
      await client.query(
        `INSERT INTO city_gold_operations (
           operation_key, city_id, actor_player_id, request_id, action, intent, result, completed_at
         ) VALUES ($1,$2::uuid,$3,$4,'land_bonus',$5::jsonb,'{}'::jsonb,clock_timestamp())`,
        [
          operationKey,
          flag.city_id,
          input.hunterPlayerId,
          createHash("sha256").update(operationKey).digest("hex"),
          JSON.stringify({ ...metadata, amount: paid })
        ]
      );
      const updated = await client.query<{ balance: string }>(
        `UPDATE city_gold_reserves
         SET balance = balance + $2::bigint,
             lifetime_land_bonus = lifetime_land_bonus + $2::bigint,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE city_id = $1::uuid
         RETURNING balance::text`,
        [flag.city_id, paid]
      );
      await client.query(
        `INSERT INTO city_gold_ledger (
           operation_key, city_id, player_id, entry_type, delta,
           balance_after, source_type, source_id, metadata
         ) VALUES ($1,$2::uuid,$3,'land_bonus',$4,$5,'combat_settlement',$6,$7::jsonb)`,
        [operationKey, flag.city_id, input.hunterPlayerId, paid, updated.rows[0]!.balance,
          input.settlementKey, JSON.stringify(metadata)]
      );
    }
    payout = {
      payeeKind: "city",
      payeeId: flag.city_id,
      flagId: flag.flag_id,
      killGold: input.killGold,
      paidGold: paid
    };
  } else if (flag.control_type === "kingdom" || flag.control_type === "kingdom_seat") {
    if (!flag.kingdom_id) return null;
    const member = await client.query(
      `SELECT 1 FROM kingdom_memberships
       WHERE kingdom_id=$1::uuid AND player_id=$2 AND status='active'`,
      [flag.kingdom_id, input.hunterPlayerId]
    );
    if (member.rowCount) return null;
    const kingdom = await client.query(
      "SELECT 1 FROM kingdoms WHERE id=$1::uuid AND status='active' FOR SHARE",
      [flag.kingdom_id]
    );
    if (!kingdom.rowCount) return null;
    await client.query(
      "INSERT INTO kingdom_gold_reserves (kingdom_id) VALUES ($1::uuid) ON CONFLICT (kingdom_id) DO NOTHING",
      [flag.kingdom_id]
    );
    await client.query(
      "SELECT 1 FROM kingdom_gold_reserves WHERE kingdom_id=$1::uuid FOR UPDATE",
      [flag.kingdom_id]
    );
    const updated = await client.query<{ balance: string }>(
      `UPDATE kingdom_gold_reserves
       SET balance = balance + $2::bigint,
           lifetime_earned = lifetime_earned + $2::bigint,
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE kingdom_id = $1::uuid
       RETURNING balance::text`,
      [flag.kingdom_id, bonus]
    );
    await client.query(
      `INSERT INTO kingdom_gold_ledger (
         operation_key, kingdom_id, player_id, entry_type, delta,
         balance_after, source_type, source_id, metadata
       ) VALUES ($1,$2::uuid,$3,'land_bonus',$4,$5,'combat_settlement',$6,$7::jsonb)`,
      [operationKey, flag.kingdom_id, input.hunterPlayerId, bonus, updated.rows[0]!.balance,
        input.settlementKey, JSON.stringify(metadata)]
    );
    payout = {
      payeeKind: "kingdom",
      payeeId: flag.kingdom_id,
      flagId: flag.flag_id,
      killGold: input.killGold,
      paidGold: bonus
    };
  } else {
    return null;
  }

  await client.query(
    `INSERT INTO land_owner_bonus_payouts (
       settlement_key, hunter_player_id, payee_kind, payee_id, flag_id,
       kill_gold, bonus_gold, paid_gold
     ) VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8)
     ON CONFLICT (settlement_key) DO NOTHING`,
    [input.settlementKey, input.hunterPlayerId, payout.payeeKind, payout.payeeId, payout.flagId,
      input.killGold, bonus, payout.paidGold]
  );
  return payout;
}
