import { SPECIALIZATION_IDS, isSpecializationAvailable, type SpecializationId } from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Rank of `specializationId` when it is the player's ACTIVE specialization, else 0. Server-authoritative read
 * for economy seams that must not trust a client-sent class. Pass the caller's transaction client to read inside it.
 */
export async function activeSpecializationRank(
  queryable: Queryable,
  playerId: string,
  specializationId: SpecializationId
): Promise<number> {
  if (!SPECIALIZATION_IDS.includes(specializationId) || !isSpecializationAvailable(specializationId)) return 0;
  const result = await queryable.query<{ rank: number }>(
    `SELECT ranks.rank
     FROM player_specialization_state state
     JOIN player_specialization_ranks ranks
       ON ranks.player_id = state.player_id AND ranks.specialization_id = state.active_specialization_id
     WHERE state.player_id = $1 AND state.active_specialization_id = $2`,
    [playerId, specializationId]
  );
  return Math.max(0, Number(result.rows[0]?.rank ?? 0));
}
