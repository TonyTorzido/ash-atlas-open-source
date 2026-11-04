import {
  CREATURE_BOOK_HABITATS,
  CREATURE_BOOK_ROSTER,
  INVENTORY_CATALOG,
  isCreatureBookArchetype,
  PLANT_BOOK_ROSTER,
  type CombatEntitySnapshot,
  type CreatureBookSnapshot,
  type MobArchetypeKey,
  type PlantBookKey
} from "@ash-atlas/shared";
import type pg from "pg";

import { requireMobDefinition } from "./combat/mobDefinitions.js";
import { populationV2MobRegistry } from "./populationV2MobRegistry.js";

export type CreatureBookSourceKind = "combat_settlement" | "legendary_bird_event" | "xoral_event";

const PLANT_KEYS = new Set<PlantBookKey>(PLANT_BOOK_ROSTER.map(({ plantKey }) => plantKey));
const XORAL_DROPS = ["ring_plain", "chopping_ring", "mining_ring", "attack_ring"] as const;

const CURRENT_FLAX_AUTHORITY_SQL = `
  EXISTS (
    SELECT 1
    FROM population_spawn_slots_v2 AS authority_slot
    JOIN population_zone_generations_v2 AS authority_generation
      ON authority_generation.generation_id=authority_slot.generation_id
     AND authority_generation.plan_id=authority_slot.plan_id
    JOIN population_zones_v2 AS authority_plan
      ON authority_plan.plan_id=authority_slot.plan_id
    JOIN population_zone_cutovers_v2 AS authority_cutover
      ON authority_cutover.zone_id=authority_plan.zone_id
     AND authority_cutover.geometry_version=authority_plan.geometry_version
    JOIN population_entity_state_v2 AS authority_state
      ON authority_state.entity_id=authority_slot.entity_id
    WHERE authority_slot.entity_id=tree.population_v2_entity_id
      AND authority_slot.plan_id=tree.population_v2_plan_id
      AND authority_slot.entity_kind='flax'
      AND authority_generation.zone_id=authority_plan.zone_id
      AND authority_generation.is_current
      AND authority_generation.status='active'
      AND authority_generation.expires_at > statement_timestamp()
      AND authority_plan.zone_id=tree.physical_population_zone_v2_id
      AND authority_plan.status='ready'
      AND authority_cutover.selected_plan_id=authority_plan.plan_id
      AND authority_cutover.serving_version='v2'
      AND authority_cutover.status='stable'
      AND authority_cutover.cutover_revision=tree.population_cutover_revision
      AND authority_state.state_revision=tree.population_v2_state_revision
      AND authority_state.state='ready'
      AND tree.state='available'
      AND tree.harvested_at IS NULL
      AND tree.harvested_by_player_id IS NULL
  )`;

export type CreatureBookPlantHarvestInput = Readonly<{
  playerId: string;
  plantKey: PlantBookKey;
  sourceId: string;
}>;

export async function recordCreatureBookKillInTransaction(
  client: pg.PoolClient,
  input: Readonly<{
    playerId: string;
    sourceKind: CreatureBookSourceKind;
    sourceId: string;
    mobArchetype: MobArchetypeKey;
    itemIds: readonly string[];
  }>
): Promise<void> {
  if (!isCreatureBookArchetype(input.mobArchetype)) return;
  await client.query(
    `INSERT INTO creature_book_kill_occurrences (player_id,source_kind,source_id,mob_archetype)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [input.playerId, input.sourceKind, input.sourceId, input.mobArchetype]
  );
  await client.query(
    `INSERT INTO creature_book_sightings (player_id,mob_archetype,first_source_entity_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [input.playerId, input.mobArchetype, `credited-kill:${input.sourceKind}:${input.sourceId}`]
  );
  const itemIds = [...new Set(input.itemIds)];
  if (itemIds.length > 0) {
    await client.query(
      `INSERT INTO creature_book_drop_occurrences (player_id,source_kind,source_id,item_id)
       SELECT $1,$2,$3,item_id FROM unnest($4::text[]) item_id
       ON CONFLICT DO NOTHING`,
      [input.playerId, input.sourceKind, input.sourceId, itemIds]
    );
  }
}

export async function recordCreatureBookPlantHarvestInTransaction(
  client: pg.PoolClient,
  input: CreatureBookPlantHarvestInput
): Promise<void> {
  if (!PLANT_KEYS.has(input.plantKey)) return;
  await client.query(
    `INSERT INTO creature_book_plant_harvests
       (player_id,plant_key,source_id)
     VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [input.playerId, input.plantKey, input.sourceId]
  );
}

export class CreatureBookService {
  private readonly recentSightings = new Map<string, true>();
  private static readonly MAX_RECENT_SIGHTINGS = 50_000;

  constructor(private readonly pool: pg.Pool) {}

  async recordPlantHarvestInTransaction(
    client: pg.PoolClient,
    input: CreatureBookPlantHarvestInput
  ): Promise<void> {
    await recordCreatureBookPlantHarvestInTransaction(client, input);
  }

  async recordVisibleCreatures(playerId: string, entities: readonly CombatEntitySnapshot[]): Promise<void> {
    const sightings = new Map<MobArchetypeKey, string>();
    const pendingCacheKeys = new Set<string>();
    for (const entity of entities) {
      if (entity.kind !== "mob" || entity.lifeState !== "alive" || !entity.archetypeKey) continue;
      if (!isCreatureBookArchetype(entity.archetypeKey)) continue;
      const normalCacheKey = `${playerId}:normal:${entity.archetypeKey}`;
      if (!this.recentSightings.has(normalCacheKey)) {
        this.recentSightings.set(normalCacheKey, true);
        pendingCacheKeys.add(normalCacheKey);
        sightings.set(entity.archetypeKey, entity.entityId);
      }
    }
    if (sightings.size === 0) return;
    const archetypes = [...sightings.keys()];
    try {
      await this.pool.query(
        `INSERT INTO creature_book_sightings (player_id,mob_archetype,first_source_entity_id)
         SELECT $1,archetype,entity_id
         FROM unnest($2::text[],$3::text[]) sighting(archetype,entity_id)
         ON CONFLICT DO NOTHING`,
        [
          playerId,
          archetypes,
          archetypes.map((archetype) => sightings.get(archetype)!)
        ]
      );
      while (this.recentSightings.size > CreatureBookService.MAX_RECENT_SIGHTINGS) {
        const oldest = this.recentSightings.keys().next().value as string | undefined;
        if (!oldest) break;
        this.recentSightings.delete(oldest);
      }
    } catch (error) {
      for (const cacheKey of pendingCacheKeys) this.recentSightings.delete(cacheKey);
      throw error;
    }
  }

  async snapshot(playerId: string): Promise<CreatureBookSnapshot> {
    const [sightings, kills, drops, plantHarvests, activeFlax] = await Promise.all([
      this.pool.query<{ mob_archetype: MobArchetypeKey; count: string }>(
        `SELECT mob_archetype,count(*)::text AS count FROM creature_book_sightings
         WHERE player_id=$1 GROUP BY mob_archetype`, [playerId]
      ),
      this.pool.query<{ mob_archetype: MobArchetypeKey; count: string }>(
        `SELECT mob_archetype,count(*)::text AS count FROM creature_book_kill_occurrences
         WHERE player_id=$1 GROUP BY mob_archetype`, [playerId]
      ),
      this.pool.query<{ mob_archetype: MobArchetypeKey; item_id: string; count: string }>(
        `SELECT kill.mob_archetype,drop.item_id,count(*)::text AS count
         FROM creature_book_drop_occurrences drop
         JOIN creature_book_kill_occurrences kill
           USING (player_id,source_kind,source_id)
         WHERE drop.player_id=$1 GROUP BY kill.mob_archetype,drop.item_id`, [playerId]
      ),
      this.pool.query<{ plant_key: PlantBookKey; count: string }>(
        `SELECT plant_key,count(*)::text AS count
         FROM creature_book_plant_harvests
         WHERE player_id=$1 GROUP BY plant_key`, [playerId]
      ),
      this.pool.query<{ count: string }>(
        `SELECT (
           (
             SELECT count(DISTINCT tree.population_v2_entity_id)
             FROM collectible_nodes AS tree
             WHERE tree.resource_type='flax_fiber'
               AND tree.population_v2_entity_id IS NOT NULL
               AND NOT tree.population_v2_suppressed
               AND ${CURRENT_FLAX_AUTHORITY_SQL}
           ) + (
             SELECT count(*)
             FROM developer_spawned_plants AS developer_plant
             WHERE developer_plant.plant_key='flax'
               AND developer_plant.state='available'
           )
         )::text AS count`
      )
    ]);
    const sightingCounts = new Map(sightings.rows.map((row) => [row.mob_archetype, Number(row.count)]));
    const killCounts = new Map(kills.rows.map((row) => [row.mob_archetype, Number(row.count)]));
    const dropCounts = new Map(drops.rows.map((row) => [`${row.mob_archetype}:${row.item_id}`, Number(row.count)]));
    const plantHarvestCounts = new Map(plantHarvests.rows.map((row) => [row.plant_key, Number(row.count)]));
    const activeFlaxCount = Number(activeFlax.rows[0]?.count ?? 0);
    return {
      slots: CREATURE_BOOK_ROSTER.map((entry) => {
        const sightingCount = sightingCounts.get(entry.archetypeKey) ?? 0;
        if (sightingCount === 0) return { bookOrder: entry.bookOrder, unlocked: false } as const;
        const killCount = killCounts.get(entry.archetypeKey) ?? 0;
        const definition = populationV2MobRegistry.definitions.find(
          (candidate) => candidate.combatArchetype === entry.archetypeKey
        );
        // Dusk-and-night mobs (the undead fantasy mobs) read as night creatures.
        const mechanicalPhase = definition?.worldTimePhaseEligibility !== undefined
          && !definition.worldTimePhaseEligibility.includes("day")
          ? "NIGHT"
          : definition?.mechanicalPhaseEligibility ?? "ANY";
        return {
          bookOrder: entry.bookOrder,
          unlocked: true,
          archetypeKey: entry.archetypeKey,
          name: entry.name,
          rarity: entry.rarity,
          ashenUnlocked: false, // legacy wire field: older clients still require it
          habitat: entry.habitatThreshold === null
            ? { kind: "legendary", habitat: "N/A", active: "any_time" } as const
            : {
                kind: "natural" as const,
                progress: killCount,
                threshold: entry.habitatThreshold,
                restrictions: killCount >= entry.habitatThreshold
                  ? CREATURE_BOOK_HABITATS[entry.archetypeKey]
                  : null,
                active: mechanicalPhase === "DAY"
                  ? "day" as const
                  : mechanicalPhase === "NIGHT"
                    ? "night" as const
                    : "any_time" as const
              },
          killCount: killCount === 0 ? null : killCount,
          drops: possibleDrops(entry.archetypeKey).map((itemId, slotOrder) => {
            const occurrenceCount = dropCounts.get(`${entry.archetypeKey}:${itemId}`) ?? 0;
            if (occurrenceCount === 0) return { slotOrder, observed: false } as const;
            return {
              slotOrder,
              observed: true as const,
              itemId,
              displayName: INVENTORY_CATALOG[itemId]?.displayName ?? itemId,
              occurrenceCount,
              observedRate: killCount === 0 ? 0 : occurrenceCount / killCount
            };
          })
        };
      }),
      plants: PLANT_BOOK_ROSTER.map((entry) => {
        const totalHarvests = plantHarvestCounts.get(entry.plantKey) ?? 0;
        if (totalHarvests === 0) {
          return { bookOrder: entry.bookOrder, unlocked: false } as const;
        }
        return {
          bookOrder: entry.bookOrder,
          unlocked: true,
          plantKey: entry.plantKey,
          name: entry.name,
          rarity: entry.rarity,
          active: activeFlaxCount,
          totalHarvests,
          habitat: {
            kind: "natural" as const,
            progress: totalHarvests,
            threshold: entry.habitatThreshold,
            restrictions: totalHarvests >= entry.habitatThreshold
              ? entry.habitatRestrictions
              : null
          }
        };
      })
    };
  }
}

function possibleDrops(archetype: MobArchetypeKey): readonly string[] {
  if (archetype === "xoral") return XORAL_DROPS;
  if (archetype === "fire_bird") return ["fire_feather"];
  if (archetype === "lightning_bird") return ["tempest_quill"];
  if (archetype === "ice_bird") return ["ice_feather"];
  const rewards = requireMobDefinition(archetype).rewards;
  return [...new Set([...rewards.items, ...rewards.chanceItems].map(({ itemId }) => itemId))];
}
