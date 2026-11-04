import type pg from "pg";

import type { WorldSampleInput } from "./service.js";

type CountRow = Readonly<{
  entity_category: string;
  persisted_count: string | number;
}>;

export async function loadGlobalWorldTelemetry(
  pool: Pick<pg.Pool, "query">
): Promise<WorldSampleInput[]> {
  const result = await pool.query<CountRow>(
    `SELECT 'players' AS entity_category, count(*) AS persisted_count
       FROM players
     UNION ALL
     SELECT 'personal_flags', count(*) FROM flags WHERE control_type='personal'
     UNION ALL
     SELECT 'city_flags', count(*) FROM flags
       WHERE control_type IN ('city','city_seat')
     UNION ALL
     SELECT 'kingdom_flags', count(*) FROM flags
       WHERE control_type IN ('kingdom','kingdom_seat')
     UNION ALL
     SELECT 'cities', count(*) FROM cities WHERE active
     UNION ALL
     SELECT 'kingdoms', count(*) FROM kingdoms WHERE status='active'
     UNION ALL
     SELECT 'manors', count(*) FROM player_manors
     UNION ALL
     SELECT 'dropped_items', count(*) FROM world_item_drops WHERE status='active'
     UNION ALL
     SELECT 'market_orders', count(*) FROM market_orders
       WHERE status IN ('open','partially_filled')
     UNION ALL
     SELECT 'pending_market_collections', count(*) FROM market_collections
       WHERE remaining_amount > 0`
  );
  return result.rows.map((row) => ({
    scopeType: "global",
    scopeId: "all",
    entityCategory: row.entity_category,
    persistedCount: Number(row.persisted_count),
    reconciliationSource: "postgres_reconciliation"
  }));
}
