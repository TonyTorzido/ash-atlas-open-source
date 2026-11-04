-- Make the retired Manor Storage guard fail closed when the migration-only
-- transaction setting is absent. Migration 0854 is already recorded; this
-- forward-only repair preserves its immutable history and controlled writes.

LOCK TABLE
  manor_storage_stacks,
  manor_storage_overflow,
  equipment_instances,
  player_backpack_instances
IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION reject_retired_manor_storage_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  location text;
BEGIN
  -- Equipment and backpack rows share this trigger with their other custody
  -- locations. Only a mutation that would touch retired Manor Storage is
  -- rejected; normal inventory/world/market transitions remain available.
  IF TG_TABLE_NAME IN ('equipment_instances', 'player_backpack_instances') THEN
    IF TG_OP = 'DELETE' THEN
      location := OLD.location;
      IF location IS DISTINCT FROM 'manor_storage' THEN
        RETURN OLD;
      END IF;
    ELSIF TG_OP = 'INSERT' THEN
      IF NEW.location IS DISTINCT FROM 'manor_storage' THEN
        RETURN NEW;
      END IF;
    ELSIF OLD.location IS DISTINCT FROM 'manor_storage'
      AND NEW.location IS DISTINCT FROM 'manor_storage' THEN
      RETURN NEW;
    END IF;
  END IF;
  IF current_setting('ash_atlas.manor_storage_recovery', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Manor Storage is retired; recover items from the Manor recovery pile'
      USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
