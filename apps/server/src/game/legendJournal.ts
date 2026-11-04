import {
  CREATURE_BOOK_ROSTER,
  FURNACE_METAL_BAR_RECIPE_IDS,
  MOB_BIOME_VARIANT_FAMILIES,
  MOB_BIOME_VARIANT_FAMILY_BASES,
  LEGEND_CATALOG,
  PROFESSION_IDS,
  eligibleLegendIds,
  professionMaxRank,
  type LegendJournalSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

/**
 * The journal reads the same durable receipts that award gameplay progress.
 * It never increments counters from client requests, inventory possession, or a
 * replayable notification. Award rows are permanent, even after items are spent.
 */
export class LegendJournalService {
  constructor(private readonly pool: pg.Pool, private readonly now: () => number = Date.now) {}

  async snapshot(playerId: string): Promise<LegendJournalSnapshot> {
    if (!playerId || playerId.length > 160) throw new Error("Invalid journal player ID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const metricRows = await client.query<{ metric: string; value: string | number }>(LEGEND_METRICS_SQL, [playerId]);
      const metrics: Record<string, number> = Object.fromEntries(metricRows.rows.map(({ metric, value }) => [
        metric, Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(value)))
      ]));
      metrics.habitats_mastered = CREATURE_BOOK_ROSTER.filter((creature) =>
        creature.habitatThreshold !== null && (metrics[`kills_${creature.archetypeKey}`] ?? 0) >= creature.habitatThreshold
      ).length;
      metrics.profession_masters = PROFESSION_IDS.filter((profession) =>
        (metrics[`profession_${profession}`] ?? 0) >= professionMaxRank(profession)
      ).length;

      const existing = await client.query<{ achievement_id: string; unlocked_at: Date | string }>(
        COMPLETIONS_SQL, [playerId, CATALOG_IDS]
      );
      const eligible = eligibleLegendIds(
        LEGEND_CATALOG, metrics, new Set(existing.rows.map((row) => row.achievement_id))
      );
      let newlyCompletedIds: string[] = [];
      if (eligible.length > 0) {
        const inserted = await client.query<{ achievement_id: string }>(
          `INSERT INTO player_achievements (player_id,achievement_id)
           SELECT $1,achievement_id FROM unnest($2::text[]) AS achievement_id
           ON CONFLICT (player_id,achievement_id) DO NOTHING
           RETURNING achievement_id`,
          [playerId, eligible]
        );
        newlyCompletedIds = inserted.rows.map((row) => row.achievement_id);
      }
      // Re-read after conflict resolution, so concurrent requests see the winning
      // commit and only the request that inserted an award announces it as new.
      const completedRows = eligible.length > 0
        ? await client.query<{ achievement_id: string; unlocked_at: Date | string }>(
          COMPLETIONS_SQL, [playerId, CATALOG_IDS]
        )
        : existing;
      const completed = Object.fromEntries(completedRows.rows.map((row) => [
        row.achievement_id, new Date(row.unlocked_at).toISOString()
      ]));
      await client.query("COMMIT");
      return { playerId, metrics, completed, newlyCompletedIds, serverTime: this.now() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

const CATALOG_IDS = LEGEND_CATALOG.map((entry) => entry.id);
const COMPLETIONS_SQL = `SELECT achievement_id,unlocked_at FROM player_achievements
 WHERE player_id=$1 AND achievement_id=ANY($2::text[])`;

// Each CTE is restricted to one authenticated player. Completed sessions count
// actions, while workshop progress counts only output actually collected.
const LEGEND_METRICS_SQL = `
WITH kills AS (
  SELECT mob_archetype,count(*) AS quantity
  FROM creature_book_kill_occurrences WHERE player_id=$1 GROUP BY mob_archetype
), harvests AS (
  SELECT operation_key,resource_type FROM harvest_sessions WHERE player_id=$1 AND status='completed'
  UNION
  SELECT receipt.operation_key,session.resource_type
  FROM repeatable_resource_harvests receipt
  JOIN repeatable_resource_sessions session ON session.operation_key=receipt.operation_key
  WHERE receipt.player_id=$1 AND session.player_id=$1 AND session.status='completed'
), smelts AS (
  SELECT job.recipe_id,
    CASE WHEN job.recipe_id='iron_bar' THEN (
      SELECT count(*) FROM furnace_smelt_units unit
      WHERE unit.job_id=job.job_id AND unit.unit_index<=job.collected_quantity AND unit.outcome='success'
    ) ELSE job.collected_quantity END AS successful_quantity
  FROM furnace_smelt_jobs job WHERE job.owner_player_id=$1
), tanning AS (
  SELECT recipe_id,collected_quantity FROM tannery_jobs WHERE owner_player_id=$1
), cooking AS (
  SELECT recipe_id,collected_quantity FROM kitchen_jobs WHERE owner_player_id=$1
)
SELECT 'kills_' || mob_archetype AS metric,quantity::text AS value FROM kills
UNION ALL SELECT 'kills_total',COALESCE(sum(quantity),0)::text FROM kills
${MOB_BIOME_VARIANT_FAMILY_BASES.map((base) => `UNION ALL SELECT 'kills_${base}_family',COALESCE(sum(quantity),0)::text FROM kills
  WHERE mob_archetype IN (${MOB_BIOME_VARIANT_FAMILIES[base].map((key) => `'${key}'`).join(",")})
`).join("")}UNION ALL SELECT 'species_defeated',count(*)::text FROM kills
UNION ALL SELECT 'legendary_bird_species',count(*)::text FROM kills WHERE mob_archetype IN ('fire_bird','lightning_bird','ice_bird')
UNION ALL SELECT 'species_seen',count(*)::text FROM creature_book_sightings WHERE player_id=$1
UNION ALL SELECT 'drop_types',count(DISTINCT item_id)::text FROM creature_book_drop_occurrences WHERE player_id=$1
UNION ALL SELECT 'xoral_ring_types',count(DISTINCT item_id)::text FROM creature_book_drop_occurrences
  WHERE player_id=$1 AND source_kind='xoral_event' AND item_id IN ('chopping_ring','mining_ring','attack_ring','ring_plain')
UNION ALL SELECT 'harvests_total',count(*)::text FROM harvests
UNION ALL SELECT 'harvest_' || resource_type,count(*)::text FROM harvests GROUP BY resource_type
UNION ALL SELECT 'smelted_bars',COALESCE(sum(successful_quantity),0)::text FROM smelts
  WHERE recipe_id IN ('iron_bar',${FURNACE_METAL_BAR_RECIPE_IDS.map((id) => `'${id}'`).join(",")},'slag_recovery')
UNION ALL SELECT 'smelt_recipe_types',count(DISTINCT recipe_id)::text FROM smelts WHERE successful_quantity>0
UNION ALL SELECT 'leather_made',COALESCE(sum(collected_quantity),0)::text FROM tanning
UNION ALL SELECT 'tannery_recipe_types',count(DISTINCT recipe_id)::text FROM tanning WHERE collected_quantity>0
UNION ALL SELECT 'cloth_woven',COALESCE(sum(collected_quantity),0)::text FROM loom_jobs WHERE owner_player_id=$1
UNION ALL SELECT 'meals_cooked',COALESCE(sum(collected_quantity),0)::text FROM cooking
UNION ALL SELECT 'kitchen_recipe_types',count(DISTINCT recipe_id)::text FROM cooking WHERE collected_quantity>0
UNION ALL SELECT 'sewer_wardens_defeated',count(*)::text
  FROM combat_reward_participants participant
  JOIN combat_reward_settlements settlement USING (settlement_key)
  WHERE participant.player_id=$1 AND participant.authoritative_damage>0
    AND settlement.status='completed' AND settlement.mob_archetype='sewer_rat_miniboss'
    AND settlement.candidate#>>'{bossOwnership,hostKind}'='dungeon'
    AND settlement.candidate#>>'{bossOwnership,bossId}'='sewer_rat_miniboss'
    AND settlement.candidate#>>'{bossOwnership,encounterInstanceId}' LIKE '%:rat-warden:%'
UNION ALL SELECT 'profession_' || profession_id,rank::text FROM player_profession_progress WHERE player_id=$1
UNION ALL SELECT 'level',level::text FROM player_progression_profiles WHERE player_id=$1
UNION ALL SELECT 'poison_damage_taken',value::text FROM player_stats WHERE player_id=$1 AND stat_key='poison_damage_taken'
UNION ALL SELECT 'biomes_discovered',count(*)::text FROM player_biome_discoveries WHERE player_id=$1
UNION ALL SELECT 'biome_' || biome_id,'1' FROM player_biome_discoveries WHERE player_id=$1
`;
