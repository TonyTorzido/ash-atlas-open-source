import {
  cityMarketLevel,
  cityTowerSlotCapacity,
  type CityTowerSlotsSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * City Tower slots: one per City Market level, up to 10, against the
 * standing City Towers of the city. A Market mid-upgrade still counts its
 * previous level; a Market still being built gives none. Read under the
 * caller's `city-structure:<cityId>` advisory lock when it gates an upgrade,
 * so two concurrent City Tower upgrades cannot both take the last slot.
 */
export async function cityTowerSlotsSnapshot(
  queryable: Queryable,
  cityId: string
): Promise<CityTowerSlotsSnapshot> {
  const result = await queryable.query<{ market_level: number; used: number }>(
    `SELECT COALESCE((
              SELECT CASE WHEN state = 'active' THEN tier ELSE tier - 1 END
              FROM city_structures
              WHERE city_id = $1::uuid AND structure_type = 'market' AND state IN ('active', 'constructing')
              ORDER BY state LIMIT 1
            ), 0)::int AS market_level,
            (
              SELECT count(*)::int FROM flags
              WHERE city_id = $1::uuid AND control_type = 'city' AND tower_level IS NOT NULL
                AND territory_collapse_id IS NULL AND (health IS NULL OR health > 0)
            ) AS used`,
    [cityId]
  );
  const marketLevel = cityMarketLevel(Number(result.rows[0]?.market_level ?? 0));
  return { marketLevel, used: Number(result.rows[0]?.used ?? 0), capacity: cityTowerSlotCapacity(marketLevel) };
}

export function cityTowerSlotsMessage(slots: CityTowerSlotsSnapshot): string {
  return slots.marketLevel === 0
    ? "City Towers need a City Market: each Market level opens one City Tower slot."
    : `All ${slots.capacity} City Tower slots are in use. Upgrade the City Market to open another (one per level, up to 10).`;
}
