import {
  KINGDOM_ACTIVE_MEMBER_WINDOW_MS,
  KINGDOM_TERRITORY_SPACING_M,
  kingdomStructureCapacity,
  type KingdomStructureCapacitySnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Standing Kingdom Flags (Obelisks and Kingdom Towers included, the Castle
 * not) against the cap of 36 per member active in the last 6 days. Read
 * under the caller's locks; the kingdom flag network lock serializes
 * conversions of the same kingdom.
 */
export async function kingdomStructureCapacitySnapshot(
  queryable: Queryable,
  kingdomId: string
): Promise<KingdomStructureCapacitySnapshot> {
  const result = await queryable.query<{ used: number; active_members: number }>(
    `SELECT (
              SELECT count(*)::int FROM flags
              WHERE kingdom_id = $1::uuid AND control_type = 'kingdom'
                AND war_structure_kind IS NULL
                AND territory_collapse_id IS NULL AND (health IS NULL OR health > 0)
            ) AS used,
            (
              SELECT count(*)::int FROM kingdom_memberships membership
              JOIN players player ON player.id = membership.player_id
              WHERE membership.kingdom_id = $1::uuid AND membership.status = 'active'
                AND player.last_seen_at >= clock_timestamp() - ($2::bigint * interval '1 millisecond')
            ) AS active_members`,
    [kingdomId, KINGDOM_ACTIVE_MEMBER_WINDOW_MS]
  );
  const row = result.rows[0];
  const activeMembers = Number(row?.active_members ?? 0);
  return { used: Number(row?.used ?? 0), capacity: kingdomStructureCapacity(activeMembers), activeMembers };
}

export function kingdomCapacityMessage(snapshot: KingdomStructureCapacitySnapshot): string {
  return `The Kingdom is at its structure limit: ${snapshot.used.toLocaleString("en-US")} of ` +
    `${snapshot.capacity.toLocaleString("en-US")} (36 per member active in the last 6 days, ` +
    `${snapshot.activeMembers} active). Existing structures stay; new ones wait for more active members.`;
}

/**
 * The nearest other active kingdom's territory flag whose territory lies
 * within 2.4 km of the given flag's territory (edge to edge), or null. No
 * alliances exist, so every other kingdom counts as non-allied.
 */
export async function findKingdomWithinSpacing(
  queryable: Queryable,
  flagId: string,
  ownKingdomId: string | null
): Promise<{ flagId: string; kingdomName: string; distanceM: number } | null> {
  const result = await queryable.query<{ id: string; kingdom_name: string; distance_m: number }>(
    `SELECT neighbor.id::text, kingdom.display_name AS kingdom_name,
            GREATEST(0, ST_Distance(target.geom::geography, neighbor.geom::geography)
              - target.claim_radius_m - neighbor.claim_radius_m) AS distance_m
     FROM flags target
     JOIN flags neighbor ON neighbor.id <> target.id
      AND neighbor.kingdom_id IS NOT NULL
      AND neighbor.kingdom_id IS DISTINCT FROM $2::uuid
      AND neighbor.control_type IN ('kingdom', 'kingdom_seat')
      AND neighbor.territory_collapse_id IS NULL
      AND neighbor.war_structure_kind IS NULL
      AND ST_DWithin(
        target.geom::geography,
        neighbor.geom::geography,
        target.claim_radius_m + neighbor.claim_radius_m + $3
      )
     JOIN kingdoms kingdom ON kingdom.id = neighbor.kingdom_id AND kingdom.status = 'active'
     WHERE target.id = $1::uuid
     ORDER BY distance_m, neighbor.id
     LIMIT 1`,
    [flagId, ownKingdomId, KINGDOM_TERRITORY_SPACING_M]
  );
  const row = result.rows[0];
  return row ? { flagId: row.id, kingdomName: row.kingdom_name, distanceM: Number(row.distance_m) } : null;
}

export function kingdomSpacingMessage(neighbor: { kingdomName: string; distanceM: number }): string {
  return `Too close to the Kingdom of ${neighbor.kingdomName}: its territory is ` +
    `${Math.round(neighbor.distanceM).toLocaleString("en-US")} m away, and kingdoms must stay 2.4 km apart.`;
}
