-- Generated finite identities, placement, and consumed history are append-only.

CREATE OR REPLACE FUNCTION protect_generated_resource_placement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_flag_id IS NOT NULL THEN
      RAISE EXCEPTION 'generated tree history cannot be deleted'
        USING ERRCODE = '23514', CONSTRAINT = 'collectible_nodes_generated_tree_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.source_flag_id IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.lat IS DISTINCT FROM OLD.lat OR
    NEW.lon IS DISTINCT FROM OLD.lon OR NEW.geom IS DISTINCT FROM OLD.geom OR
    NEW.source_flag_id IS DISTINCT FROM OLD.source_flag_id OR
    NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
    NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
    (OLD.state = 'harvested' AND NEW.state <> 'harvested') OR
    (OLD.harvested_at IS NOT NULL AND NEW.harvested_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'generated tree identity, placement, and consumption are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'collectible_nodes_generated_tree_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collectible_nodes_protect_generated_resource ON collectible_nodes;
CREATE TRIGGER collectible_nodes_protect_generated_resource
BEFORE UPDATE OR DELETE ON collectible_nodes
FOR EACH ROW EXECUTE FUNCTION protect_generated_resource_placement();

CREATE OR REPLACE FUNCTION protect_generated_wolf_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'generated wolf history cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'generated_resource_wolves_immutable';
  END IF;
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id OR
     NEW.source_flag_id IS DISTINCT FROM OLD.source_flag_id OR
     NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
     NEW.region_code IS DISTINCT FROM OLD.region_code OR
     NEW.lat IS DISTINCT FROM OLD.lat OR NEW.lon IS DISTINCT FROM OLD.lon OR
     NEW.geom IS DISTINCT FROM OLD.geom OR
     NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
     (OLD.killed_at IS NOT NULL AND NEW.killed_at IS NULL) OR
     (OLD.killed_by_player_id IS NOT NULL AND NEW.killed_by_player_id IS NULL)
  THEN
    RAISE EXCEPTION 'generated wolf identity, placement, and death are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'generated_resource_wolves_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS generated_resource_wolves_protect_history ON generated_resource_wolves;
CREATE TRIGGER generated_resource_wolves_protect_history
BEFORE UPDATE OR DELETE ON generated_resource_wolves
FOR EACH ROW EXECUTE FUNCTION protect_generated_wolf_history();

CREATE OR REPLACE FUNCTION reject_finite_spawn_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finite resource spawn events are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'flag_resource_spawn_events_immutable';
END;
$$;

DROP TRIGGER IF EXISTS flag_resource_spawn_events_immutable ON flag_resource_spawn_events;
CREATE TRIGGER flag_resource_spawn_events_immutable
BEFORE UPDATE OR DELETE ON flag_resource_spawn_events
FOR EACH ROW EXECUTE FUNCTION reject_finite_spawn_event_mutation();
