-- Developer test targets keep their spawning developer as the durable Flag
-- owner so cleanup remains deterministic.  Give that narrow burn path an
-- explicit source identity instead of weakening the ordinary player-burn
-- actor invariant from 0839.

ALTER TABLE flag_burn_operations
  ADD COLUMN IF NOT EXISTS developer_test_creator_id text;

ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_source_check;

ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_source_check CHECK (
    (
      source_kind = 'player'
      AND burner_player_id IS NOT NULL
      AND developer_test_creator_id IS NULL
      AND legendary_event_id IS NULL
      AND burner_player_id <> victim_player_id
    )
    OR
    (
      source_kind = 'developer_test'
      AND burner_player_id IS NOT NULL
      AND developer_test_creator_id IS NOT NULL
      AND burner_player_id = developer_test_creator_id
      AND victim_player_id = developer_test_creator_id
      AND legendary_event_id IS NULL
    )
    OR
    (
      source_kind = 'legendary_bird'
      AND burner_player_id IS NULL
      AND developer_test_creator_id IS NULL
      AND legendary_event_id IS NOT NULL
    )
  );

-- A check constraint cannot safely inspect the mutable Flags/test-fixture
-- tables.  Keep that cross-row part authoritative with a narrow insert/update
-- trigger; completed operation history remains available after a Flag is
-- deleted because it does not create a retaining foreign key.
CREATE OR REPLACE FUNCTION validate_developer_test_flag_burn_source()
RETURNS trigger AS $$
BEGIN
  IF NEW.source_kind = 'developer_test' AND NOT EXISTS (
    SELECT 1
    FROM flags flag
    JOIN developer_spawned_test_flags test ON test.flag_id = flag.id
    WHERE flag.id = NEW.flag_id
      AND flag.developer_test_target
      AND flag.owner_id = NEW.developer_test_creator_id
      AND test.creator_player_id = NEW.developer_test_creator_id
  ) THEN
    RAISE EXCEPTION
      'developer_test flag burn source must match a marked developer test target';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS flag_burn_operations_developer_test_source ON flag_burn_operations;
CREATE TRIGGER flag_burn_operations_developer_test_source
BEFORE INSERT OR UPDATE OF source_kind,developer_test_creator_id,flag_id
ON flag_burn_operations
FOR EACH ROW
EXECUTE FUNCTION validate_developer_test_flag_burn_source();

COMMENT ON COLUMN flag_burn_operations.source_kind IS
  'Burn source: player for ordinary warfare, developer_test for a spawning developer fixture, or legendary_bird for a canonical encounter burn.';
COMMENT ON COLUMN flag_burn_operations.developer_test_creator_id IS
  'Spawning developer identity for a developer_test burn; NULL for ordinary player and legendary-bird burns.';
