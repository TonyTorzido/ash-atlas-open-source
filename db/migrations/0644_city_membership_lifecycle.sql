ALTER TABLE city_memberships
  ADD COLUMN IF NOT EXISTS world_id text NULL;

UPDATE city_memberships membership
SET world_id = city.world_id
FROM cities city
WHERE city.id = membership.city_id
  AND membership.world_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM city_memberships WHERE world_id IS NULL) THEN
    RAISE EXCEPTION 'city membership world backfill found a membership without a city';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM city_memberships
    WHERE left_at IS NULL
    GROUP BY player_id, world_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate active city memberships exist for one player and world';
  END IF;
END
$$;

ALTER TABLE city_memberships
  ALTER COLUMN world_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cities_id_world_id_unique
  ON cities (id, world_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'city_memberships'::regclass
      AND conname = 'city_memberships_city_world_fkey'
  ) THEN
    ALTER TABLE city_memberships
      ADD CONSTRAINT city_memberships_city_world_fkey
      FOREIGN KEY (city_id, world_id) REFERENCES cities(id, world_id) ON DELETE CASCADE;
  END IF;
END
$$;

DROP INDEX IF EXISTS city_memberships_one_active_per_player_idx;
CREATE UNIQUE INDEX IF NOT EXISTS city_memberships_one_active_per_player_world_idx
  ON city_memberships (player_id, world_id)
  WHERE left_at IS NULL;

ALTER TABLE city_mutations
  DROP CONSTRAINT IF EXISTS city_mutations_operation_valid,
  ADD CONSTRAINT city_mutations_operation_valid CHECK (
    operation IN (
      'join_city',
      'leave_city',
      'convert_city_flag',
      'claim_city_mayor',
      'relinquish_city_mayor'
    )
  );
