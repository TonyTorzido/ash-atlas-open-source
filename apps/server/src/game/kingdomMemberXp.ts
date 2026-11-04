import { randomUUID } from "node:crypto";

import {
  KINGDOM_LEVEL_DEFINITION_VERSION,
  KINGDOM_MAX_LEVEL,
  KINGDOM_MEMBER_XP_DAILY_CAP,
  kingdomLevelForXp
} from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

export type KingdomMemberXpCredit = Readonly<{
  kingdomId: string;
  xpDay: string;
  creditedXp: number;
  dailyXp: number;
  /** The new stored level when this credit raised it, else null. */
  newLevel: number | null;
}>;

/**
 * Kingdom XP from member activity: every XP point an active kingdom member earns
 * adds one kingdom XP, capped per kingdom per UTC day. Runs inside the XP
 * grant's own transaction after its replay check, so a replayed grant never
 * credits twice. The cap is applied by one upsert on the (kingdom, day) row:
 * concurrent members serialize on that row and the CHECK backs the cap.
 * Member XP only ever raises the stored level; it never lowers it.
 */
export async function creditKingdomMemberXpInTransaction(
  queryable: Queryable,
  input: Readonly<{ playerId: string; xp: number; operationKey: string }>
): Promise<KingdomMemberXpCredit | null> {
  if (!Number.isSafeInteger(input.xp) || input.xp <= 0) return null;
  const day = await queryable.query<{
    kingdom_id: string;
    xp_day: string;
    credited_xp: number;
    last_credited_xp: number;
  }>(
    `WITH member AS (
       SELECT m.kingdom_id
       FROM kingdom_memberships m
       JOIN kingdoms k ON k.id = m.kingdom_id AND k.status = 'active'
       WHERE m.player_id = $1 AND m.status = 'active'
       LIMIT 1
     )
     INSERT INTO kingdom_member_xp_days AS d (
       kingdom_id, xp_day, earned_xp, credited_xp, last_credited_xp, grant_count
     )
     SELECT kingdom_id, (now() AT TIME ZONE 'UTC')::date, $2::bigint, LEAST($2::bigint, $3::bigint),
            LEAST($2::bigint, $3::bigint), 1
     FROM member
     ON CONFLICT (kingdom_id, xp_day) DO UPDATE SET
       earned_xp = d.earned_xp + EXCLUDED.earned_xp,
       credited_xp = LEAST($3::bigint, d.credited_xp + EXCLUDED.earned_xp),
       last_credited_xp = LEAST($3::bigint, d.credited_xp + EXCLUDED.earned_xp) - d.credited_xp,
       grant_count = d.grant_count + 1,
       updated_at = now()
     RETURNING kingdom_id, xp_day::text AS xp_day, credited_xp, last_credited_xp`,
    [input.playerId, input.xp, KINGDOM_MEMBER_XP_DAILY_CAP]
  );
  const row = day.rows[0];
  if (!row) return null;
  const credited = Number(row.last_credited_xp);
  const dailyXp = Number(row.credited_xp);
  if (credited <= 0) {
    return { kingdomId: row.kingdom_id, xpDay: row.xp_day, creditedXp: 0, dailyXp, newLevel: null };
  }

  const updated = await queryable.query<{ level: number; lifetime_xp: string | number }>(
    `UPDATE kingdoms
     SET current_xp = current_xp + $2, lifetime_xp = lifetime_xp + $2
     WHERE id = $1 AND status = 'active'
     RETURNING level, lifetime_xp`,
    [row.kingdom_id, credited]
  );
  const kingdom = updated.rows[0];
  if (!kingdom) throw new Error("Kingdom changed while member XP was credited");
  const levelBefore = Number(kingdom.level);
  const lifetimeXpAfter = Number(kingdom.lifetime_xp);
  const xpLevel = Math.min(kingdomLevelForXp(lifetimeXpAfter).level, KINGDOM_MAX_LEVEL);
  if (xpLevel <= levelBefore) {
    return { kingdomId: row.kingdom_id, xpDay: row.xp_day, creditedXp: credited, dailyXp, newLevel: null };
  }

  // The row is locked by the UPDATE above, so the level cannot move underneath.
  await queryable.query(
    `UPDATE kingdoms
     SET level = $2, level_definition_version = $3,
         spatial_revision = nextval('kingdom_spatial_revision_seq')
     WHERE id = $1 AND level < $2`,
    [row.kingdom_id, xpLevel, KINGDOM_LEVEL_DEFINITION_VERSION]
  );
  await queryable.query(
    `INSERT INTO kingdom_xp_ledger (
       id, kingdom_id, source_type, source_id, actor_player_id, request_id,
       xp_delta, xp_before, xp_after, level_before, level_after,
       level_definition_version, metadata
     ) VALUES ($1,$2,'member_xp',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      randomUUID(),
      row.kingdom_id,
      input.operationKey,
      input.playerId,
      `member-xp:${input.operationKey}`,
      credited,
      lifetimeXpAfter - credited,
      lifetimeXpAfter,
      levelBefore,
      xpLevel,
      KINGDOM_LEVEL_DEFINITION_VERSION,
      JSON.stringify({ xpDay: row.xp_day, dailyXp })
    ]
  );
  await queryable.query(
    `INSERT INTO kingdom_audit_events (
       id, kingdom_id, actor_player_id, target_player_id, event_type, entity_type, entity_id, metadata
     ) VALUES ($1,$2,NULL,NULL,'kingdom_level_up',NULL,NULL,$3::jsonb)`,
    [randomUUID(), row.kingdom_id, JSON.stringify({ levelBefore, levelAfter: xpLevel, lifetimeXp: lifetimeXpAfter })]
  );
  return { kingdomId: row.kingdom_id, xpDay: row.xp_day, creditedXp: credited, dailyXp, newLevel: xpLevel };
}

/** Member XP credited to the kingdom this UTC day. */
export async function loadKingdomDailyMemberXp(queryable: Queryable, kingdomId: string): Promise<number> {
  const result = await queryable.query<{ credited_xp: number }>(
    `SELECT credited_xp FROM kingdom_member_xp_days
     WHERE kingdom_id = $1 AND xp_day = (now() AT TIME ZONE 'UTC')::date`,
    [kingdomId]
  );
  return Number(result.rows[0]?.credited_xp ?? 0);
}
