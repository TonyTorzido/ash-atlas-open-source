-- Quarantine retained tree projections that are no longer owned by the
-- selected, current Population V2 generation. Preserve identities, canonical
-- state, spawn slots, and harvest history for diagnosis and rollback safety.
UPDATE collectible_nodes AS tree
SET population_cutover_suppressed=true
WHERE tree.resource_type='wood'
  AND tree.population_v2_entity_id IS NOT NULL
  AND NOT tree.population_cutover_suppressed
  AND NOT EXISTS (
    SELECT 1
    FROM population_spawn_slots_v2 AS slot
    JOIN population_zone_generations_v2 AS generation
      ON generation.generation_id=slot.generation_id
     AND generation.plan_id=slot.plan_id
    JOIN population_zones_v2 AS plan
      ON plan.plan_id=slot.plan_id
    JOIN population_zone_cutovers_v2 AS cutover
      ON cutover.zone_id=plan.zone_id
     AND cutover.geometry_version=plan.geometry_version
    JOIN population_entity_state_v2 AS state
      ON state.entity_id=slot.entity_id
    WHERE slot.entity_id=tree.population_v2_entity_id
      AND slot.plan_id=tree.population_v2_plan_id
      AND slot.entity_kind='tree'
      AND generation.zone_id=plan.zone_id
      AND generation.is_current
      AND generation.status='active'
      AND generation.expires_at > statement_timestamp()
      AND plan.zone_id=tree.physical_population_zone_v2_id
      AND plan.status='ready'
      AND cutover.selected_plan_id=plan.plan_id
      AND cutover.serving_version='v2'
      AND cutover.status='stable'
      AND cutover.cutover_revision=tree.population_cutover_revision
      AND state.state_revision=tree.population_v2_state_revision
      AND (
        (
          state.state='ready'
          AND tree.state='available'
          AND tree.harvested_at IS NULL
          AND tree.harvested_by_player_id IS NULL
        )
        OR
        (
          state.state='harvested'
          AND tree.state='harvested'
          AND tree.harvested_at=state.killed_or_harvested_at
          AND tree.harvested_by_player_id
            IS NOT DISTINCT FROM state.state_actor_player_id
        )
      )
  );
