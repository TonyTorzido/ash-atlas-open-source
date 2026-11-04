-- Replace accumulating finite-resource allowances with one immediately-created,
-- fully-replaced tree/wolf generation per active flag.

ALTER TABLE flag_resource_spawn_allowances
  RENAME COLUMN next_spawn_allowance_at TO next_resource_reset_at;

ALTER TABLE flag_resource_spawn_allowances
  RENAME COLUMN last_spawn_allowance_at TO last_materialized_at;

ALTER TABLE flag_resource_spawn_events
  ADD COLUMN expired_at timestamptz NULL;

-- Historical harvest sessions keep the immutable node ID as a ledger reference,
-- but expired generated-tree rows no longer remain in the active gameplay table.
ALTER TABLE harvest_sessions
  DROP CONSTRAINT IF EXISTS harvest_sessions_node_id_fkey;

DROP TRIGGER IF EXISTS collectible_nodes_protect_generated_resource ON collectible_nodes;
CREATE OR REPLACE FUNCTION protect_current_generated_tree()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_flag_id IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.lat IS DISTINCT FROM OLD.lat OR
    NEW.lon IS DISTINCT FROM OLD.lon OR NEW.geom IS DISTINCT FROM OLD.geom OR
    NEW.source_flag_id IS DISTINCT FROM OLD.source_flag_id OR
    NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
    NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
    (OLD.state = 'harvested' AND NEW.state <> 'harvested') OR
    (OLD.harvested_at IS NOT NULL AND NEW.harvested_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'current generated tree identity, placement, and consumption are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'collectible_nodes_current_generated_tree_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collectible_nodes_protect_generated_resource
BEFORE UPDATE ON collectible_nodes
FOR EACH ROW EXECUTE FUNCTION protect_current_generated_tree();

DROP TRIGGER IF EXISTS generated_resource_wolves_protect_history ON generated_resource_wolves;
CREATE OR REPLACE FUNCTION protect_current_generated_wolf()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
    RAISE EXCEPTION 'current generated wolf identity, placement, and death are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'generated_resource_wolves_current_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER generated_resource_wolves_protect_history
BEFORE UPDATE ON generated_resource_wolves
FOR EACH ROW EXECUTE FUNCTION protect_current_generated_wolf();

DROP TRIGGER IF EXISTS flag_resource_spawn_events_immutable ON flag_resource_spawn_events;
CREATE OR REPLACE FUNCTION protect_flag_resource_generation_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     NEW.flag_id IS DISTINCT FROM OLD.flag_id OR
     NEW.generation IS DISTINCT FROM OLD.generation OR
     NEW.seed_version IS DISTINCT FROM OLD.seed_version OR
     NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
     NEW.rolled_tree_count IS DISTINCT FROM OLD.rolled_tree_count OR
     NEW.rolled_wolf_count IS DISTINCT FROM OLD.rolled_wolf_count OR
     NEW.actual_tree_count IS DISTINCT FROM OLD.actual_tree_count OR
     NEW.actual_wolf_count IS DISTINCT FROM OLD.actual_wolf_count OR
     NEW.materialized_at IS DISTINCT FROM OLD.materialized_at OR
     (OLD.expired_at IS NOT NULL AND NEW.expired_at IS DISTINCT FROM OLD.expired_at) OR
     (OLD.expired_at IS NULL AND NEW.expired_at IS NULL)
  THEN
    RAISE EXCEPTION 'flag resource generation audits are immutable except for first expiration'
      USING ERRCODE = '23514', CONSTRAINT = 'flag_resource_spawn_events_compact_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER flag_resource_spawn_events_immutable
BEFORE UPDATE OR DELETE ON flag_resource_spawn_events
FOR EACH ROW EXECUTE FUNCTION protect_flag_resource_generation_audit();

CREATE OR REPLACE FUNCTION initialize_flag_resource_spawn_allowance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO flag_resource_spawn_allowances (flag_id, next_resource_reset_at)
  VALUES (NEW.id, clock_timestamp())
  ON CONFLICT (flag_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Existing flags without a generation become eligible immediately. Existing
-- valid/overdue generation schedules retain their already-recorded timestamp.
UPDATE flag_resource_spawn_allowances
SET next_resource_reset_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE active AND spawn_generation = 0;

CREATE OR REPLACE FUNCTION deactivate_flag_resource_spawn_allowance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE flag_resource_spawn_allowances
  SET active = false, updated_at = clock_timestamp()
  WHERE flag_id = OLD.id;

  UPDATE flag_resource_spawn_events
  SET expired_at = clock_timestamp()
  WHERE flag_id = OLD.id AND expired_at IS NULL;

  UPDATE harvest_sessions
  SET status = 'cancelled', cancelled_at = clock_timestamp()
  WHERE status = 'active'
    AND node_id IN (SELECT id FROM collectible_nodes WHERE source_flag_id = OLD.id);

  DELETE FROM collectible_nodes WHERE source_flag_id = OLD.id;
  DELETE FROM generated_resource_wolves WHERE source_flag_id = OLD.id;
  RETURN OLD;
END;
$$;
