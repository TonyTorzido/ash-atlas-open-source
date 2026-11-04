-- Fix forward: legacy generated mobs must be able to acquire their physical
-- Population v2 cutover classification while v2-owned mob identity remains
-- immutable.

CREATE OR REPLACE FUNCTION protect_generated_world_mob()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_authorized boolean;
BEGIN
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id OR
     NEW.encounter_id IS DISTINCT FROM OLD.encounter_id OR
     NEW.mob_archetype IS DISTINCT FROM OLD.mob_archetype OR
     NEW.pack_id IS DISTINCT FROM OLD.pack_id OR
     NEW.source_population_area_id IS DISTINCT FROM OLD.source_population_area_id OR
     NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
     NEW.spawn_cell_id IS DISTINCT FROM OLD.spawn_cell_id OR
     NEW.region_code IS DISTINCT FROM OLD.region_code OR
     NEW.lat IS DISTINCT FROM OLD.lat OR NEW.lon IS DISTINCT FROM OLD.lon OR
     NEW.geom IS DISTINCT FROM OLD.geom OR
     NEW.anchor_lat IS DISTINCT FROM OLD.anchor_lat OR
     NEW.anchor_lon IS DISTINCT FROM OLD.anchor_lon OR
     NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
     NEW.environment_world_identity_key IS DISTINCT FROM OLD.environment_world_identity_key OR
     NEW.environment_profile_version IS DISTINCT FROM OLD.environment_profile_version OR
     NEW.environment_candidate_slot_version IS DISTINCT FROM OLD.environment_candidate_slot_version OR
     NEW.environment_cell_id IS DISTINCT FROM OLD.environment_cell_id OR
     NEW.environment_slot_id IS DISTINCT FROM OLD.environment_slot_id OR
     NEW.environment_snapshot IS DISTINCT FROM OLD.environment_snapshot OR
     NEW.population_v2_entity_id IS DISTINCT FROM OLD.population_v2_entity_id OR
     NEW.population_v2_plan_id IS DISTINCT FROM OLD.population_v2_plan_id OR
     (OLD.population_v2_entity_id IS NOT NULL AND
       NEW.physical_population_zone_v2_id IS DISTINCT FROM OLD.physical_population_zone_v2_id)
  THEN
    RAISE EXCEPTION 'generated world mob identity, encounter, placement, environment, and ownership are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_world_mobs_current_immutable';
  END IF;

  IF OLD.population_v2_entity_id IS NOT NULL AND (
    NEW.killed_at IS DISTINCT FROM OLD.killed_at OR
    NEW.killed_by_player_id IS DISTINCT FROM OLD.killed_by_player_id OR
    NEW.population_v2_state_revision IS DISTINCT FROM OLD.population_v2_state_revision
  ) THEN
    SELECT EXISTS (
      SELECT 1 FROM population_entity_state_v2 AS state
      WHERE state.entity_id = NEW.population_v2_entity_id
        AND state.state_revision = NEW.population_v2_state_revision
        AND (
          (state.state = 'ready' AND NEW.killed_at IS NULL
            AND NEW.killed_by_player_id IS NULL)
          OR
          (state.state = 'dead'
            AND NEW.killed_at = state.killed_or_harvested_at
            AND NEW.killed_by_player_id IS NOT DISTINCT FROM state.state_actor_player_id)
        )
    ) INTO state_authorized;
    IF NOT state_authorized THEN
      RAISE EXCEPTION 'population v2 mob state must follow canonical revision'
        USING ERRCODE = '23514',
              CONSTRAINT = 'generated_world_mobs_population_v2_state_authority';
    END IF;
  ELSIF OLD.population_v2_entity_id IS NULL AND (
    (OLD.killed_at IS NOT NULL AND NEW.killed_at IS NULL) OR
    (OLD.killed_by_player_id IS NOT NULL AND NEW.killed_by_player_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'generated world mob death is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_world_mobs_current_immutable';
  END IF;
  RETURN NEW;
END;
$$;
