import type pg from "pg";

import type { DeathPenaltyInput } from "./progression.js";

type Queryable = Pick<pg.Pool, "query">;

type Logger = { warn(object: unknown, message: string): void };

export type PvpDeath = Readonly<{
  killerPlayerId: string;
  /** The killer landed the killing blow themself, so the PvP death gold may move. */
  goldEligible: boolean;
  revenantArmor: boolean;
}>;

/** Recorded killers older than this are pruned on start (every death settles long before). */
const PENDING_DEATH_RETENTION = "7 days";

export async function prunePvpPendingDeaths(pool: Queryable): Promise<void> {
  await pool.query(
    `DELETE FROM player_pvp_pending_deaths WHERE created_at < now() - interval '${PENDING_DEATH_RETENTION}'`
  );
}

/**
 * Who killed this player, for the PvP death losses.
 *
 * The live death attempt carries the killer in its metadata and records it
 * durably. A retry recovered from the combat profile after a crash or restart
 * only knows the death operation key and reads the killer back, so the PvP
 * losses (each idempotent per death key) still apply exactly once. No record
 * means a PvE death: no PvP losses, never a guess.
 */
export async function resolvePvpDeath(
  pool: Queryable,
  input: DeathPenaltyInput,
  logger?: Logger
): Promise<PvpDeath | null> {
  const killerPlayerId = typeof input.metadata?.killerPlayerId === "string" ? input.metadata.killerPlayerId : null;
  if (killerPlayerId === input.playerId) return null;
  if (killerPlayerId) {
    const death: PvpDeath = {
      killerPlayerId,
      goldEligible: input.metadata?.pvpGoldEligible === true,
      revenantArmor: input.metadata?.revenantArmor === true
    };
    try {
      await pool.query(
        `INSERT INTO player_pvp_pending_deaths (
           death_operation_key, victim_player_id, killer_player_id, gold_eligible, revenant_armor
         ) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (death_operation_key) DO NOTHING`,
        [input.operationKey, input.playerId, killerPlayerId, death.goldEligible, death.revenantArmor]
      );
    } catch (error: unknown) {
      logger?.warn({ err: error, playerId: input.playerId, operationKey: input.operationKey }, "failed to record PvP death killer");
    }
    return death;
  }
  const recorded = await pool.query<{ killer_player_id: string; gold_eligible: boolean; revenant_armor: boolean }>(
    `SELECT killer_player_id, gold_eligible, revenant_armor FROM player_pvp_pending_deaths
     WHERE death_operation_key = $1 AND victim_player_id = $2`,
    [input.operationKey, input.playerId]
  );
  const row = recorded.rows[0];
  return row ? { killerPlayerId: row.killer_player_id, goldEligible: row.gold_eligible, revenantArmor: row.revenant_armor } : null;
}
