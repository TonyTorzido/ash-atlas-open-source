DO $$
DECLARE
  mismatch record;
BEGIN
  FOR mismatch IN
    SELECT tree.population_v2_entity_id AS entity_id,
           tree.physical_population_zone_v2_id AS zone_id,
           slot.generation_id,
           tree.population_v2_state_revision AS incoming_revision,
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
    LIMIT 20
  LOOP
    RAISE WARNING
      'population tree projection mismatch: operation_type=tree-projection-repair entity_id=% zone_id=% generation_id=% incoming_revision=% canonical_revision=%',
      mismatch.entity_id,
      mismatch.zone_id,
      mismatch.generation_id,
      mismatch.incoming_revision,
      mismatch.canonical_revision;
  END LOOP;
END;
$$;

UPDATE collectible_nodes AS tree
SET state=CASE WHEN state.state='ready' THEN 'available' ELSE 'harvested' END,
    harvested_at=CASE WHEN state.state='ready'
      THEN NULL ELSE state.killed_or_harvested_at END,
    harvested_by_player_id=CASE WHEN state.state='ready'
      THEN NULL ELSE state.state_actor_player_id END,
    population_v2_state_revision=state.state_revision
FROM population_entity_state_v2 AS state
WHERE state.entity_id=tree.population_v2_entity_id
  AND tree.resource_type='wood'
  AND EXISTS (
    SELECT 1
    FROM population_plan_spawn_slots_v2 AS slot
    WHERE slot.entity_id=tree.population_v2_entity_id
      AND slot.entity_kind='tree'
  )
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
  );

DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT COUNT(*)
  INTO remaining
  FROM collectible_nodes AS tree
  JOIN population_entity_state_v2 AS state
    ON state.entity_id=tree.population_v2_entity_id
  WHERE tree.resource_type='wood'
    AND EXISTS (
      SELECT 1
      FROM population_plan_spawn_slots_v2 AS slot
      WHERE slot.entity_id=tree.population_v2_entity_id
        AND slot.entity_kind='tree'
    )
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
    );
  IF remaining <> 0 THEN
    RAISE EXCEPTION
      'population tree projection repair left % canonical mismatch(es)',
      remaining;
  END IF;
END;
$$;
