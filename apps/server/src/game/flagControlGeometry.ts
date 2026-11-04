import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export const FLAG_CONTROL_TOUCH_TOLERANCE_M = 0.05;

const FLAG_CONTROL_GEOMETRY_LOCK_KEY = "flag-control-geometry";

export type FlagControlRecord = {
  control_type: "personal" | "city" | "city_seat" | "kingdom" | "kingdom_seat";
  owner_id: string;
  kingdom_id: string | null;
};

export function isPersonalFlagControlledByPlayer(
  flag: Pick<FlagControlRecord, "control_type" | "owner_id">,
  playerId: string
): boolean {
  return flag.control_type === "personal" && flag.owner_id === playerId;
}

export async function lockFlagControlGeometry(queryable: Queryable): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [FLAG_CONTROL_GEOMETRY_LOCK_KEY]
  );
}

export async function findForeignOrganizationConnection(
  queryable: Queryable,
  flagId: string,
  allowedCityId: string | null,
  allowedKingdomId: string | null
): Promise<string | null> {
  const result = await queryable.query<{ id: string }>(
    `SELECT neighbor.id
     FROM flags target
     JOIN flags neighbor ON neighbor.id <> target.id
      AND (
        (neighbor.city_id IS NOT NULL AND neighbor.city_id IS DISTINCT FROM $2::uuid)
        OR
        (neighbor.kingdom_id IS NOT NULL AND neighbor.kingdom_id IS DISTINCT FROM $3::uuid)
      )
      AND ST_DWithin(
        target.geom::geography,
        neighbor.geom::geography,
        target.claim_radius_m + neighbor.claim_radius_m + $4
      )
     WHERE target.id = $1
     ORDER BY neighbor.id
     LIMIT 1`,
    [flagId, allowedCityId, allowedKingdomId, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  return result.rows[0]?.id ?? null;
}
