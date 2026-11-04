import type pg from "pg";
import type { GeneratedPopulationZoneV2Plan, PopulationZoneV2PlanSlot } from "./populationZonesV2Plan.js";
import { populationV2ProjectionRowForSlot } from "./populationZonesV2Store.js";

// Seed historical retained lives explicitly: current generation creation always
// uses authored encounter tables and cannot impersonate an older writer.
export async function replaceHistoricalGenerationFixture(
  pool: pg.Pool,
  plan: GeneratedPopulationZoneV2Plan,
  generationId: string,
  slots: readonly PopulationZoneV2PlanSlot[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE population_zone_generations_v2 SET status='expired' WHERE generation_id=$1::uuid", [generationId]);
    const ids = await client.query<{ entity_id: string }>("SELECT entity_id FROM population_spawn_slots_v2 WHERE generation_id=$1::uuid", [generationId]);
    const entityIds = ids.rows.map((row) => row.entity_id);
    for (const table of ["collectible_nodes", "generated_world_mobs"] as const) {
      await client.query(`DELETE FROM ${table} WHERE population_v2_entity_id=ANY($1::uuid[])`, [entityIds]);
    }
    await client.query("DELETE FROM population_entity_state_v2 WHERE entity_id=ANY($1::uuid[])", [entityIds]);
    await client.query("DELETE FROM population_spawn_slots_v2 WHERE generation_id=$1::uuid", [generationId]);
    await client.query("DELETE FROM population_generation_mob_rollouts_v2 WHERE generation_id=$1::uuid", [generationId]);
    await client.query("DELETE FROM population_generation_kind_manifest_v2 WHERE generation_id=$1::uuid", [generationId]);
    await client.query("UPDATE population_zone_generations_v2 SET status='active' WHERE generation_id=$1::uuid", [generationId]);
    await insertSpawnSlots(client, { planId: plan.planId, generationId, slots });
    await client.query("INSERT INTO population_entity_state_v2 (entity_id,state) SELECT unnest($1::uuid[]),'ready'", [slots.map((slot) => slot.entityId)]);
    const cutover = await client.query<{ cutover_revision: string }>("SELECT cutover_revision FROM population_zone_cutovers_v2 WHERE zone_id=$1", [plan.identity.zoneId]);
    await insertPlanProjections(client, { ...plan, slots: [...slots] }, Number(cutover.rows[0]!.cutover_revision), [...new Set(slots.filter((slot) => slot.entityKind !== "tree").map((slot) => slot.entityKind))]);
    await client.query("UPDATE population_zone_generations_v2 SET status='active',planned_nonstone_count=$2,materialization_revision='historical-fixture',common_schema_revision='population-common-schema-v1' WHERE generation_id=$1::uuid", [generationId, slots.length]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertSpawnSlots(
  client: pg.PoolClient,
  input: Readonly<{
    planId: string;
    generationId: string | null;
    slots: readonly PopulationZoneV2PlanSlot[];
  }>
): Promise<void> {
  if (input.slots.length === 0) return;
  await client.query(
    `INSERT INTO population_spawn_slots_v2 (
       plan_id, generation_id, slot_id, entity_id, candidate_id, entity_kind,
       archetype, encounter_id, pack_id, pack_member_index,
       latitude, longitude, geom, anchor_latitude, anchor_longitude,
       anchor_geom, environment_snapshot, suppression_class
     )
     SELECT $1::uuid, $2::uuid, slot.slot_id, slot.entity_id,
            slot.candidate_id, slot.entity_kind, slot.archetype,
            slot.encounter_id, slot.pack_id, slot.pack_member_index,
            slot.latitude, slot.longitude,
            ST_SetSRID(ST_MakePoint(slot.longitude, slot.latitude),4326)::geography,
            slot.anchor_latitude, slot.anchor_longitude,
            ST_SetSRID(ST_MakePoint(
              slot.anchor_longitude, slot.anchor_latitude
            ),4326)::geography,
            slot.environment_snapshot, slot.suppression_class
     FROM jsonb_to_recordset($3::jsonb) AS slot(
       slot_id uuid, entity_id uuid, candidate_id text,
       entity_kind text, archetype text, encounter_id uuid,
       pack_id uuid, pack_member_index smallint,
       latitude double precision, longitude double precision,
       anchor_latitude double precision, anchor_longitude double precision,
       environment_snapshot jsonb, suppression_class text
     )`,
    [
      input.planId,
      input.generationId,
      JSON.stringify(input.slots.map((slot) => populationV2ProjectionRowForSlot({ slot, regionCode: "historical-fixture", defaultPlacementVersion: "historical-fixture" })))
    ]
  );
}

async function insertPlanProjections(
  client: pg.PoolClient,
  plan: GeneratedPopulationZoneV2Plan,
  cutoverRevision: number,
  runtimeMobKinds: readonly string[],
  registeredMobPlacementRevisionsByEntityId:
    ReadonlyMap<string, string> = new Map()
): Promise<void> {
  const projectionRows = plan.slots.map((slot) =>
    populationV2ProjectionRowForSlot({
      slot,
      regionCode: plan.habitat.regionCode,
      defaultPlacementVersion: plan.identity.candidateLayoutVersion,
      ...(registeredMobPlacementRevisionsByEntityId.get(slot.entityId) ===
          undefined
        ? {}
        : {
            registeredPlacementRevision:
              registeredMobPlacementRevisionsByEntityId.get(slot.entityId)!
          })
    })
  );
  const spawnCells = new Map<
    string,
    (typeof projectionRows)[number]
  >();
  for (const row of projectionRows) spawnCells.set(row.spawn_cell_id, row);
  await client.query(
    `INSERT INTO spawn_cells (
       id, region_code, cell_x, cell_y, center_lat, center_lon
     )
     SELECT cell.spawn_cell_id, cell.spawn_cell_region_code,
            cell.spawn_cell_x, cell.spawn_cell_y,
            cell.spawn_cell_center_lat, cell.spawn_cell_center_lon
     FROM jsonb_to_recordset($1::jsonb) AS cell(
       spawn_cell_id text, spawn_cell_region_code text,
       spawn_cell_x integer, spawn_cell_y integer,
       spawn_cell_center_lat double precision,
       spawn_cell_center_lon double precision
     )
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify([...spawnCells.values()])]
  );

  await client.query(
    `INSERT INTO collectible_nodes (
       id, cell_id, region_code, resource_type, quantity,
       lat, lon, geom, state, harvested_at, harvested_by_player_id,
       env_snapshot,
       placement_version, population_v2_entity_id,
       physical_population_zone_v2_id, population_v2_plan_id,
       population_v2_state_revision, population_cutover_revision,
       population_cutover_suppressed
     )
     SELECT tree.entity_id::text, tree.spawn_cell_id, $2, 'wood',
            tree.tree_yield_quantity,
            tree.latitude, tree.longitude,
            ST_SetSRID(ST_MakePoint(tree.longitude, tree.latitude),4326),
            CASE WHEN canonical.state='ready' THEN 'available' ELSE 'harvested' END,
            CASE WHEN canonical.state='ready'
              THEN NULL ELSE canonical.killed_or_harvested_at END,
            CASE WHEN canonical.state='ready'
              THEN NULL ELSE canonical.state_actor_player_id END,
            tree.environment_snapshot,
            $3, tree.entity_id, $4, $1::uuid,
            canonical.state_revision, $5, false
     FROM jsonb_to_recordset($6::jsonb) AS tree(
       entity_id uuid, entity_kind text, spawn_cell_id text,
       tree_yield_quantity integer,
       latitude double precision, longitude double precision,
       environment_snapshot jsonb
     )
     JOIN population_entity_state_v2 AS canonical
       ON canonical.entity_id=tree.entity_id
     WHERE tree.entity_kind = 'tree'`,
    [
      plan.planId,
      plan.habitat.regionCode,
      plan.identity.candidateLayoutVersion,
      plan.identity.zoneId,
      cutoverRevision,
      JSON.stringify(projectionRows)
    ]
  );

  await client.query(
    `INSERT INTO generated_world_mobs (
       entity_id, encounter_id, mob_archetype, pack_id,
       spawn_cell_id, region_code, lat, lon, geom,
       anchor_lat, anchor_lon, placement_version,
       environment_world_identity_key, environment_profile_version,
       environment_candidate_slot_version, environment_cell_id,
       environment_slot_id, environment_snapshot,
       population_v2_entity_id, physical_population_zone_v2_id,
       population_v2_plan_id, population_v2_state_revision,
       population_cutover_revision, population_cutover_suppressed
     )
     SELECT mob.entity_id::text, mob.encounter_id::text, mob.archetype,
            mob.pack_id::text, mob.spawn_cell_id, $2,
            mob.latitude, mob.longitude,
            ST_SetSRID(ST_MakePoint(mob.longitude, mob.latitude),4326),
            mob.anchor_latitude, mob.anchor_longitude,
            COALESCE(mob.placement_version, $3),
            NULL, NULL, NULL, NULL, NULL, mob.environment_snapshot,
            mob.entity_id, $4, $1::uuid, 0, $5, false
     FROM jsonb_to_recordset($6::jsonb) AS mob(
       entity_id uuid, entity_kind text, archetype text,
       encounter_id uuid, pack_id uuid, placement_version text,
       spawn_cell_id text, latitude double precision,
       longitude double precision, anchor_latitude double precision,
       anchor_longitude double precision, environment_snapshot jsonb
     )
     WHERE mob.entity_kind=ANY($7::text[])`,
    [
      plan.planId,
      plan.habitat.regionCode,
      plan.identity.candidateLayoutVersion,
      plan.identity.zoneId,
      cutoverRevision,
      JSON.stringify(projectionRows),
      [...runtimeMobKinds]
    ]
  );

}
