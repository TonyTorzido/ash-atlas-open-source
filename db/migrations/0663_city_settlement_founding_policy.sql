ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS settlement_founding_policy_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass
      AND conname = 'cities_settlement_founding_policy_id_nonempty'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_settlement_founding_policy_id_nonempty
      CHECK (
        settlement_founding_policy_id IS NULL
        OR length(btrim(settlement_founding_policy_id)) > 0
      );
  END IF;
END $$;

COMMENT ON COLUMN cities.settlement_founding_policy_id IS
  'Immutable World settlement founding policy used for this city claim.';
