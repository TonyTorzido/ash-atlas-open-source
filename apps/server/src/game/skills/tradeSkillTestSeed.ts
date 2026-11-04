import type pg from "pg";

import type { TradeSkillId } from "@ash-atlas/shared";

/** Integration-test setup: gives a player a trade skill rank directly (the player row must already exist). */
export async function seedTradeSkillRank(
  queryable: Pick<pg.Pool, "query">,
  playerId: string,
  skillId: TradeSkillId,
  rank: 1 | 2 | 3
): Promise<void> {
  await queryable.query(
    `INSERT INTO player_skill_ranks (player_id, skill_id, rank, points_spent)
     VALUES ($1,$2,$3,$3)
     ON CONFLICT (player_id, skill_id) DO UPDATE SET rank = EXCLUDED.rank`,
    [playerId, skillId, rank]
  );
}
