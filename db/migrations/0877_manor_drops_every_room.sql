-- Players may drop items in every Manor room (lobby, upstairs and basement
-- rooms, and any room the Studio adds), so the Manor drop projection no longer
-- pins space_id to the two original spaces. The room itself is validated by the
-- server against the authored Manor template; the database only requires a
-- non-empty id. Everything else in the projection contract is unchanged.
DO $$
DECLARE
  target text;
  existing record;
BEGIN
  FOREACH target IN ARRAY ARRAY['world_equipment_drops', 'world_item_drops', 'world_backpack_drops'] LOOP
    IF to_regclass(target) IS NULL THEN CONTINUE; END IF;
    FOR existing IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = to_regclass(target) AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%manor_foyer%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target, existing.conname);
    END LOOP;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', target, target || '_manor_projection_check');
    EXECUTE format($c$ALTER TABLE %I ADD CONSTRAINT %I CHECK (
      (manor_id IS NULL AND space_id IS NULL AND local_x IS NULL AND local_y IS NULL)
      OR (
        manor_id IS NOT NULL
        AND length(space_id) > 0
        AND local_x IS NOT NULL AND local_y IS NOT NULL
        AND local_x >= 0 AND local_y >= 0
      )
    )$c$, target, target || '_manor_projection_check');
  END LOOP;
END $$;
