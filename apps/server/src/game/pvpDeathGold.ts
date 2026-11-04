import {
  isBeginnerProtectedLevel,
  paidCharacterLevel,
  PVP_DEATH_GOLD_REPEAT_WINDOW_MS,
  pvpDeathGoldLoss,
  rogueTheftAmount
} from "@ash-atlas/shared";
import type pg from "pg";

import type { WalletService } from "./wallet.js";

export type PvpDeathGoldResult = Readonly<{
  victimLevel: number;
  beginnerProtected: boolean;
  /** The same killer already took gold from this victim in the last 20 hours: nothing moves. */
  repeatKill: boolean;
  carriedBefore: bigint;
  goldLost: bigint;
  /** Extra gold a Rogue killer stole after the normal loss (0 when not a Rogue, skipped, or nothing left). */
  rogueTheft: bigint;
  /** False when this death was already settled (replay). */
  applied: boolean;
  /** Wallet balances after the transfer; null on a replay or when no gold moved. */
  victimWallet: Readonly<{ gold: bigint; version: bigint }> | null;
  killerWallet: Readonly<{ gold: bigint; version: bigint }> | null;
}>;

type PvpDeathGoldWallet = Pick<WalletService, "debitForOperationInTransaction" | "creditForOperationInTransaction">;

export const PVP_DEATH_GOLD_LOST_REASON = "pvp_death_gold_lost";
export const PVP_DEATH_GOLD_TAKEN_REASON = "pvp_death_gold_taken";
export const PVP_ROGUE_THEFT_LOST_REASON = "pvp_rogue_theft_lost";
export const PVP_ROGUE_THEFT_TAKEN_REASON = "pvp_rogue_theft_taken";

/**
 * PvP death gold loss for one player death: the killer takes 12% (rounded
 * down) of the victim's carried gold. Carried gold is the player wallet;
 * market escrow, unclaimed packages, and city/kingdom treasuries are not
 * carried and are never touched. Nothing moves when the victim is a beginner
 * (level 3 and under, read from progression inside this transaction) or when
 * the same killer already took gold from the same victim in the last 20
 * hours (anti-farm: colluding characters cannot use deaths as a transfer
 * channel). The caller only calls this for a killing blow landed by the
 * killer themself (not pets, undead, military units, towers, or the world).
 *
 * The amount comes from the victim's wallet balance read after the wallet row
 * is locked, so a concurrent spend either finishes first (and the 12% is of
 * what is left) or waits for this transfer; the debit can never overdraw.
 * The credit always equals the debit, in the same transaction.
 *
 * Idempotent per death: an advisory lock on the death's operation key
 * serializes replays, and the recorded row makes a repeat return the first
 * result without moving gold. Both wallets are locked in player-id order
 * before either moves, so two transfers between the same pair cannot
 * deadlock. Both legs are ledgered in wallet_events under one operation key.
 *
 * Rogue theft: when the killer's active specialization is Rogue at rank 2 or
 * more (read inside this transaction), they also steal 9% of the gold the
 * victim has LEFT after the normal loss, capped by rank. It is skipped
 * whenever the normal loss is skipped (beginner, repeat kill), so the same
 * anti-farm window covers it, and is recorded with the death so a replay
 * returns it without paying again. Its wallet legs use their own operation
 * key and reasons.
 */
export async function applyPvpDeathGoldLoss(
  pool: pg.Pool,
  wallet: PvpDeathGoldWallet,
  input: Readonly<{ deathOperationKey: string; victimPlayerId: string; killerPlayerId: string }>
): Promise<PvpDeathGoldResult | null> {
  if (input.victimPlayerId === input.killerPlayerId) return null;
  const operationKey = `pvp-death-gold:${input.deathOperationKey}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationKey]);
    const prior = await client.query<{
      victim_player_id: string;
      killer_player_id: string;
      victim_level: number;
      beginner_protected: boolean;
      repeat_kill: boolean;
      carried_before: string;
      gold_lost: string;
      rogue_theft: string;
    }>(
      `SELECT victim_player_id, killer_player_id, victim_level, beginner_protected, repeat_kill,
              carried_before::text, gold_lost::text, rogue_theft::text
       FROM player_pvp_death_gold_losses WHERE operation_key = $1`,
      [input.deathOperationKey]
    );
    if (prior.rows[0]) {
      const row = prior.rows[0];
      if (row.victim_player_id !== input.victimPlayerId || row.killer_player_id !== input.killerPlayerId) {
        throw new Error("PvP death gold operation key conflicts with another death");
      }
      await client.query("COMMIT");
      return {
        victimLevel: row.victim_level,
        beginnerProtected: row.beginner_protected,
        repeatKill: row.repeat_kill,
        carriedBefore: BigInt(row.carried_before),
        goldLost: BigInt(row.gold_lost),
        rogueTheft: BigInt(row.rogue_theft),
        applied: false,
        victimWallet: null,
        killerWallet: null
      };
    }
    const players = await client.query<{ id: string; account_id: string }>(
      "SELECT id, account_id::text FROM players WHERE id = ANY($1::text[])",
      [[input.victimPlayerId, input.killerPlayerId]]
    );
    const victimAccountId = players.rows.find((row) => row.id === input.victimPlayerId)?.account_id;
    const killerAccountId = players.rows.find((row) => row.id === input.killerPlayerId)?.account_id;
    if (!victimAccountId || !killerAccountId) {
      await client.query("COMMIT");
      return null;
    }
    const progression = await client.query<{ total_xp: string; level: number }>(
      "SELECT total_xp::text, level FROM player_progression_profiles WHERE player_id = $1",
      [input.victimPlayerId]
    );
    const victimLevel = paidCharacterLevel(Number(progression.rows[0]?.total_xp ?? 0), progression.rows[0]?.level);
    const beginnerProtected = isBeginnerProtectedLevel(victimLevel);
    // Lock both wallets in a fixed order before either moves.
    for (const playerId of [input.victimPlayerId, input.killerPlayerId].sort()) {
      await client.query(
        `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
         SELECT id, account_id, 0, 0 FROM players WHERE id = $1
         ON CONFLICT (player_id) DO NOTHING`,
        [playerId]
      );
      await client.query("SELECT 1 FROM player_wallets WHERE player_id = $1 FOR UPDATE", [playerId]);
    }
    const balance = await client.query<{ gold_balance: string }>(
      "SELECT gold_balance::text FROM player_wallets WHERE player_id = $1",
      [input.victimPlayerId]
    );
    const carriedBefore = BigInt(balance.rows[0]?.gold_balance ?? "0");
    // Both wallets are locked, so two deaths between the same pair are serialized here.
    const recent = beginnerProtected ? { rows: [] } : await client.query(
      `SELECT 1 FROM player_pvp_death_gold_losses
       WHERE victim_player_id = $1 AND killer_player_id = $2 AND gold_lost > 0
         AND created_at > now() - make_interval(secs => $3::double precision / 1000)
       LIMIT 1`,
      [input.victimPlayerId, input.killerPlayerId, PVP_DEATH_GOLD_REPEAT_WINDOW_MS]
    );
    const repeatKill = recent.rows.length > 0;
    const goldLost = beginnerProtected || repeatKill ? 0n : pvpDeathGoldLoss(carriedBefore);
    // Rogue theft rides on the base transfer: same locks, same skip rules.
    let rogueRank = 0;
    if (goldLost > 0n) {
      const spec = await client.query<{ rank: number }>(
        `SELECT ranks.rank
         FROM player_specialization_state state
         JOIN player_specialization_ranks ranks
           ON ranks.player_id = state.player_id AND ranks.specialization_id = state.active_specialization_id
         WHERE state.player_id = $1 AND state.active_specialization_id = 'rogue'`,
        [input.killerPlayerId]
      );
      rogueRank = Number(spec.rows[0]?.rank ?? 0);
    }
    const rogueTheft = goldLost > 0n ? rogueTheftAmount(rogueRank, carriedBefore - goldLost) : 0n;
    let victimWallet: PvpDeathGoldResult["victimWallet"] = null;
    let killerWallet: PvpDeathGoldResult["killerWallet"] = null;
    if (goldLost > 0n) {
      const debited = await wallet.debitForOperationInTransaction(client, {
        playerId: input.victimPlayerId,
        accountId: victimAccountId,
        amount: goldLost,
        operationKey,
        reason: PVP_DEATH_GOLD_LOST_REASON,
        metadata: { killerPlayerId: input.killerPlayerId, carriedBefore: carriedBefore.toString() }
      });
      const credited = await wallet.creditForOperationInTransaction(client, {
        playerId: input.killerPlayerId,
        accountId: killerAccountId,
        amount: goldLost,
        operationKey,
        reason: PVP_DEATH_GOLD_TAKEN_REASON,
        metadata: { victimPlayerId: input.victimPlayerId }
      });
      victimWallet = { gold: debited.goldBalance, version: debited.version };
      killerWallet = { gold: credited.goldBalance, version: credited.version };
      if (rogueTheft > 0n) {
        const theftKey = `${operationKey}:rogue-theft`;
        const stolen = await wallet.debitForOperationInTransaction(client, {
          playerId: input.victimPlayerId,
          accountId: victimAccountId,
          amount: rogueTheft,
          operationKey: theftKey,
          reason: PVP_ROGUE_THEFT_LOST_REASON,
          metadata: { killerPlayerId: input.killerPlayerId, rogueRank }
        });
        const gained = await wallet.creditForOperationInTransaction(client, {
          playerId: input.killerPlayerId,
          accountId: killerAccountId,
          amount: rogueTheft,
          operationKey: theftKey,
          reason: PVP_ROGUE_THEFT_TAKEN_REASON,
          metadata: { victimPlayerId: input.victimPlayerId, rogueRank }
        });
        victimWallet = { gold: stolen.goldBalance, version: stolen.version };
        killerWallet = { gold: gained.goldBalance, version: gained.version };
      }
    }
    await client.query(
      `INSERT INTO player_pvp_death_gold_losses (
         operation_key, victim_player_id, killer_player_id, victim_level,
         beginner_protected, repeat_kill, carried_before, gold_lost, rogue_theft
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.deathOperationKey, input.victimPlayerId, input.killerPlayerId, victimLevel,
        beginnerProtected, repeatKill, carriedBefore.toString(), goldLost.toString(), rogueTheft.toString()]
    );
    await client.query("COMMIT");
    return {
      victimLevel, beginnerProtected, repeatKill, carriedBefore, goldLost, rogueTheft, applied: true, victimWallet, killerWallet
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
