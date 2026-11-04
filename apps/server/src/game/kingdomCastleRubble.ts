import {
  KINGDOM_CASTLE_RUBBLE_DISBAND_DELAY_MS,
  type KingdomCastleRubbleSnapshot,
  type KingdomCostLine
} from "@ash-atlas/shared";
import type pg from "pg";

import { insertKingdomAuditEvent } from "./kingdomTreasuryLedger.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type CastleRuinOutcome = Readonly<{
  /**
   * ruined: the Castle just became rubble; already_ruined / changed: nothing
   * to do; inactive: the kingdom already ended (the caller breaks the stray seat).
   */
  status: "ruined" | "already_ruined" | "changed" | "inactive";
  notifyPlayerIds: string[];
}>;

/**
 * A Castle at 0 HP becomes rubble instead of ending its kingdom: the kingdom
 * stays active with its name, members, flags and treasury, and
 * castle_ruined_at turns its perks off and its building on hold. The seat
 * flag keeps 0 health, which every attack, burn, repair and siege path
 * already refuses, so rubble cannot be attacked further.
 *
 * Own transaction; lock order kingdom row then seat flag row (the same order
 * as the leader's rebuild and the kingdom's dissolve). Idempotent.
 */
export async function ruinFallenCastle(
  pool: pg.Pool,
  input: Readonly<{ kingdomId: string; seatFlagId: string }>,
  now: Date = new Date()
): Promise<CastleRuinOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const kingdom = await client.query<{ status: string; castle_ruined_at: Date | null }>(
      "SELECT status, castle_ruined_at FROM kingdoms WHERE id = $1::uuid FOR UPDATE",
      [input.kingdomId]
    );
    const row = kingdom.rows[0];
    if (!row || row.status !== "active") {
      await client.query("ROLLBACK");
      return { status: "inactive", notifyPlayerIds: [] };
    }
    if (row.castle_ruined_at !== null) {
      await client.query("ROLLBACK");
      return { status: "already_ruined", notifyPlayerIds: [] };
    }
    const seat = await client.query<{ health: number | null }>(
      `SELECT health FROM flags
       WHERE id = $1::uuid AND kingdom_id = $2::uuid AND control_type = 'kingdom_seat'
         AND territory_collapse_id IS NULL
       FOR UPDATE`,
      [input.seatFlagId, input.kingdomId]
    );
    if (!seat.rows[0] || Number(seat.rows[0].health) !== 0) {
      await client.query("ROLLBACK");
      return { status: "changed", notifyPlayerIds: [] };
    }
    await client.query(
      `UPDATE flags SET burning_started_at = NULL, burning_until = NULL, burning_reason = NULL
       WHERE id = $1::uuid`,
      [input.seatFlagId]
    );
    await client.query("UPDATE kingdoms SET castle_ruined_at = $2 WHERE id = $1::uuid", [input.kingdomId, now]);
    await insertKingdomAuditEvent(client, {
      kingdomId: input.kingdomId,
      actorPlayerId: null,
      eventType: "castle_ruined",
      entityType: "flag",
      entityId: input.seatFlagId,
      metadata: { disbandAvailableAt: new Date(now.getTime() + KINGDOM_CASTLE_RUBBLE_DISBAND_DELAY_MS).toISOString() }
    });
    const members = await client.query<{ player_id: string }>(
      "SELECT player_id FROM kingdom_memberships WHERE kingdom_id = $1::uuid AND status = 'active'",
      [input.kingdomId]
    );
    await client.query("COMMIT");
    return { status: "ruined", notifyPlayerIds: members.rows.map((member) => member.player_id) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** When disbanding a ruined kingdom unlocks. */
export function castleRubbleDisbandAvailableAt(ruinedAt: Date): Date {
  return new Date(ruinedAt.getTime() + KINGDOM_CASTLE_RUBBLE_DISBAND_DELAY_MS);
}

export function castleRubbleSnapshot(
  ruinedAt: Date | string | null,
  rebuildCost: readonly KingdomCostLine[]
): KingdomCastleRubbleSnapshot | null {
  if (ruinedAt === null) return null;
  const at = new Date(ruinedAt);
  return {
    ruinedAt: at.toISOString(),
    disbandAvailableAt: castleRubbleDisbandAvailableAt(at).toISOString(),
    rebuildCost: rebuildCost.map((line) => ({ ...line }))
  };
}

/** The Castle seat flag of a kingdom (also while it lies in rubble). */
export async function lockKingdomCastleFlag(
  client: Queryable,
  kingdomId: string
): Promise<{ id: string; health: number | null; maximumHealth: number | null } | null> {
  const result = await client.query<{ id: string; health: number | null; maximum_health: number | null }>(
    `SELECT id::text, health, maximum_health FROM flags
     WHERE kingdom_id = $1::uuid AND control_type = 'kingdom_seat' AND territory_collapse_id IS NULL
     ORDER BY created_at, id
     LIMIT 1
     FOR UPDATE`,
    [kingdomId]
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, health: row.health === null ? null : Number(row.health),
        maximumHealth: row.maximum_health === null ? null : Number(row.maximum_health) }
    : null;
}
