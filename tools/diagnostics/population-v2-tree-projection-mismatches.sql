SELECT tree.population_v2_entity_id AS entity_id,
       tree.physical_population_zone_v2_id AS zone_id,
       slot.generation_id,
       tree.state AS projection_state,
       state.state AS canonical_state,
       tree.population_v2_state_revision AS projection_revision,
       state.state_revision AS canonical_revision
FROM collectible_nodes AS tree
JOIN population_entity_state_v2 AS state
  ON state.entity_id=tree.population_v2_entity_id
JOIN population_plan_spawn_slots_v2 AS slot
  ON slot.entity_id=tree.population_v2_entity_id
WHERE tree.resource_type='wood'
  AND slot.entity_kind='tree'
  AND (
    tree.population_v2_state_revision IS DISTINCT FROM state.state_revision
    OR (state.state='ready' AND tree.state<>'available')
    OR (state.state='harvested' AND tree.state<>'harvested')
    OR tree.harvested_at IS DISTINCT FROM
      CASE WHEN state.state='ready'
        THEN NULL ELSE state.killed_or_harvested_at END
    OR tree.harvested_by_player_id IS DISTINCT FROM
      CASE WHEN state.state='ready'
        THEN NULL ELSE state.state_actor_player_id END
  )
ORDER BY tree.population_v2_entity_id
LIMIT 100;
