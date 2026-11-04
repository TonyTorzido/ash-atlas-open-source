-- Read-only, bounded audit of retained Population V2 tree authority.
-- Result 1 lists non-authoritative projections. Result 2 lists tree pairs
-- within the legacy 70m tree-spacing floor. Never infer deletion from distance.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';

WITH tree_authority AS (
  SELECT tree.id, tree.population_v2_entity_id AS entity_id,
         tree.physical_population_zone_v2_id AS projection_zone_id,
         tree.population_v2_plan_id AS projection_plan_id,
         tree.population_cutover_revision AS projection_cutover_revision,
         tree.population_v2_state_revision AS projection_state_revision,
         tree.state AS projection_state,
         tree.population_v2_suppressed AS suppressed,
         tree.geom,
         slot.plan_id AS slot_plan_id,
         slot.entity_kind AS slot_entity_kind,
         slot.generation_id,
         generation.zone_id AS generation_zone_id,
         generation.status AS generation_status,
         generation.expires_at,
         generation.is_current,
         plan.status AS plan_status,
         cutover.selected_plan_id,
         cutover.serving_version,
         cutover.status AS cutover_status,
         cutover.cutover_revision AS selected_cutover_revision,
         state.state AS canonical_state,
         state.state_revision AS canonical_state_revision,
         (
           tree.state='available'
           AND generation.generation_id IS NOT NULL
           AND NOT COALESCE(generation.is_current, false)
         ) AS available_from_non_current_generation,
         (
           tree.state='available'
           AND tree.population_v2_plan_id
             IS DISTINCT FROM cutover.selected_plan_id
         ) AS available_from_non_selected_plan,
         (
           state.entity_id IS NULL
           OR state.state_revision
             IS DISTINCT FROM tree.population_v2_state_revision
           OR (
             state.state='ready'
             AND (
               tree.state<>'available'
               OR tree.harvested_at IS NOT NULL
               OR tree.harvested_by_player_id IS NOT NULL
             )
           )
           OR (
             state.state='harvested'
             AND (
               tree.state<>'harvested'
               OR tree.harvested_at
                 IS DISTINCT FROM state.killed_or_harvested_at
               OR tree.harvested_by_player_id
                 IS DISTINCT FROM state.state_actor_player_id
             )
           )
           OR state.state NOT IN ('ready', 'harvested')
         ) AS projection_canonical_state_mismatch,
         (
           slot.entity_id IS NULL
           OR slot.generation_id IS NULL
           OR generation.generation_id IS NULL
         ) AS missing_generation_ownership,
         (
           generation.generation_id IS NOT NULL
           AND generation.zone_id IS DISTINCT FROM plan.zone_id
         ) AS generation_zone_mismatch,
         (
           state.state='harvested'
           AND tree.state='available'
         ) AS harvested_canonical_projection_available,
         (
           NOT tree.population_v2_suppressed
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
         ) AS current_authority
  FROM collectible_nodes AS tree
  LEFT JOIN population_spawn_slots_v2 AS slot
    ON slot.entity_id=tree.population_v2_entity_id
   AND slot.plan_id=tree.population_v2_plan_id
  LEFT JOIN population_zone_generations_v2 AS generation
    ON generation.generation_id=slot.generation_id
   AND generation.plan_id=slot.plan_id
  LEFT JOIN population_zones_v2 AS plan
    ON plan.plan_id=slot.plan_id
  LEFT JOIN population_zone_cutovers_v2 AS cutover
    ON cutover.zone_id=plan.zone_id
   AND cutover.geometry_version=plan.geometry_version
  LEFT JOIN population_entity_state_v2 AS state
    ON state.entity_id=slot.entity_id
  WHERE tree.resource_type='wood'
    AND tree.population_v2_entity_id IS NOT NULL
)
SELECT id, entity_id, projection_zone_id, projection_plan_id, slot_plan_id,
       slot_entity_kind, selected_plan_id, generation_id, generation_zone_id,
       generation_status, expires_at,
       is_current, plan_status, serving_version, cutover_status,
       projection_cutover_revision, selected_cutover_revision,
       projection_state, canonical_state, projection_state_revision,
       canonical_state_revision, suppressed,
       available_from_non_current_generation,
       available_from_non_selected_plan,
       projection_canonical_state_mismatch,
       missing_generation_ownership,
       generation_zone_mismatch,
       harvested_canonical_projection_available
FROM tree_authority
WHERE NOT COALESCE(current_authority, false)
ORDER BY projection_zone_id, entity_id
LIMIT 200;

WITH tree_authority AS (
  SELECT tree.id, tree.population_v2_entity_id AS entity_id, tree.geom,
         tree.physical_population_zone_v2_id AS projection_zone_id,
         tree.population_v2_plan_id AS projection_plan_id,
         tree.state AS projection_state,
         tree.population_v2_state_revision AS projection_state_revision,
         slot.generation_id,
         generation.is_current,
         generation.status AS generation_status,
         generation.expires_at,
         cutover.selected_plan_id,
         state.state AS canonical_state,
         state.state_revision AS canonical_state_revision,
         (
           NOT tree.population_v2_suppressed
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
         ) AS current_authority
  FROM collectible_nodes AS tree
  LEFT JOIN population_spawn_slots_v2 AS slot
    ON slot.entity_id=tree.population_v2_entity_id
   AND slot.plan_id=tree.population_v2_plan_id
  LEFT JOIN population_zone_generations_v2 AS generation
    ON generation.generation_id=slot.generation_id
   AND generation.plan_id=slot.plan_id
  LEFT JOIN population_zones_v2 AS plan
    ON plan.plan_id=slot.plan_id
  LEFT JOIN population_zone_cutovers_v2 AS cutover
    ON cutover.zone_id=plan.zone_id
   AND cutover.geometry_version=plan.geometry_version
  LEFT JOIN population_entity_state_v2 AS state
    ON state.entity_id=slot.entity_id
  WHERE tree.resource_type='wood'
    AND tree.population_v2_entity_id IS NOT NULL
), near_pairs AS (
  SELECT first.id AS first_id, first.entity_id AS first_entity_id,
         COALESCE(first.current_authority, false) AS first_authoritative,
         first.projection_zone_id AS first_zone_id,
         first.projection_plan_id AS first_projection_plan_id,
         first.selected_plan_id AS first_selected_plan_id,
         first.generation_id AS first_generation_id,
         first.is_current AS first_generation_is_current,
         first.generation_status AS first_generation_status,
         first.expires_at AS first_generation_expires_at,
         first.projection_state AS first_projection_state,
         first.projection_state_revision AS first_projection_state_revision,
         first.canonical_state AS first_canonical_state,
         first.canonical_state_revision AS first_canonical_state_revision,
         second.id AS second_id, second.entity_id AS second_entity_id,
         COALESCE(second.current_authority, false) AS second_authoritative,
         second.projection_zone_id AS second_zone_id,
         second.projection_plan_id AS second_projection_plan_id,
         second.selected_plan_id AS second_selected_plan_id,
         second.generation_id AS second_generation_id,
         second.is_current AS second_generation_is_current,
         second.generation_status AS second_generation_status,
         second.expires_at AS second_generation_expires_at,
         second.projection_state AS second_projection_state,
         second.projection_state_revision AS second_projection_state_revision,
         second.canonical_state AS second_canonical_state,
         second.canonical_state_revision AS second_canonical_state_revision,
         ST_Distance(first.geom::geography, second.geom::geography)
           AS distance_m
  FROM tree_authority AS first
  JOIN tree_authority AS second
    ON first.entity_id < second.entity_id
   AND ST_DWithin(
     first.geom::geography,
     second.geom::geography,
     70
   )
)
SELECT first_id, first_entity_id, first_authoritative, first_zone_id,
       first_projection_plan_id, first_selected_plan_id, first_generation_id,
       first_generation_is_current, first_generation_status,
       first_generation_expires_at, first_projection_state,
       first_projection_state_revision, first_canonical_state,
       first_canonical_state_revision,
       second_id, second_entity_id, second_authoritative, second_zone_id,
       second_projection_plan_id, second_selected_plan_id,
       second_generation_id, second_generation_is_current,
       second_generation_status, second_generation_expires_at,
       second_projection_state, second_projection_state_revision,
       second_canonical_state, second_canonical_state_revision,
       round(distance_m::numeric, 2) AS distance_m
FROM near_pairs
ORDER BY distance_m, first_entity_id, second_entity_id
LIMIT 200;

COMMIT;
