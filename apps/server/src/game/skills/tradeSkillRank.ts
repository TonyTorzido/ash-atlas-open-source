import { TRADE_SKILL_GATES, tradeSkillGateMessage, tradeSkillGateMet, type TradeSkillGateId, type TradeSkillId } from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

/** A trade skill rank read (0 when not learned). Pass the caller's transaction client to read inside it. */
export async function tradeSkillRank(queryable: Queryable, playerId: string, skillId: TradeSkillId): Promise<number> {
  const result = await queryable.query<{ rank: number }>(
    "SELECT rank FROM player_skill_ranks WHERE player_id=$1 AND skill_id=$2",
    [playerId, skillId]
  );
  return Number(result.rows[0]?.rank ?? 0);
}

/**
 * Server gate for a craft, dig or repair action. Throws the caller's own error type with the shared
 * "Needs <Skill> rank N to <action>." message; returns the rank so the caller can reuse it.
 */
export async function requireTradeSkillGate(
  queryable: Queryable,
  playerId: string,
  gateId: TradeSkillGateId,
  makeError: (message: string) => Error
): Promise<number> {
  const gate = TRADE_SKILL_GATES[gateId];
  const rank = await tradeSkillRank(queryable, playerId, gate.skillId);
  if (!tradeSkillGateMet(gate, rank)) throw makeError(tradeSkillGateMessage(gate));
  return rank;
}
