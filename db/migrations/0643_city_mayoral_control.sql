ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS mayor_player_id text NULL;

UPDATE cities
SET mayor_player_id = founder_player_id
WHERE mayor_player_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass
      AND conname = 'cities_mayor_player_id_fkey'
  ) THEN
    ALTER TABLE cities
      ADD CONSTRAINT cities_mayor_player_id_fkey
      FOREIGN KEY (mayor_player_id) REFERENCES players(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS cities_one_active_mayoralty_per_player
  ON cities (mayor_player_id)
  WHERE active AND mayor_player_id IS NOT NULL;

ALTER TABLE city_mutations
  DROP CONSTRAINT IF EXISTS city_mutations_operation_valid,
  ADD CONSTRAINT city_mutations_operation_valid CHECK (
    operation IN (
      'join_city',
      'convert_city_flag',
      'claim_city_mayor',
      'relinquish_city_mayor'
    )
  );
