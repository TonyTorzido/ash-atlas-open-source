ALTER TABLE collectible_nodes
  DROP CONSTRAINT collectible_nodes_population_v2_owner_complete,
  ADD CONSTRAINT collectible_nodes_population_v2_owner_complete CHECK (
    placement_version IS NOT NULL
    AND resource_type = 'wood'
    AND quantity IN (4, 10, 20)
    AND population_v2_entity_id IS NOT NULL
    AND id = population_v2_entity_id::text
    AND population_v2_plan_id IS NOT NULL
    AND population_v2_state_revision IS NOT NULL
    AND physical_population_zone_v2_id IS NOT NULL
    AND population_cutover_revision IS NOT NULL
  );
