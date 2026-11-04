CREATE SEQUENCE IF NOT EXISTS kingdom_spatial_revision_seq AS bigint;

ALTER TABLE kingdoms
  ADD COLUMN IF NOT EXISTS spatial_revision bigint NOT NULL
  DEFAULT nextval('kingdom_spatial_revision_seq');

ALTER TABLE kingdom_cots
  ADD COLUMN IF NOT EXISTS spatial_revision bigint NOT NULL
  DEFAULT nextval('kingdom_spatial_revision_seq');

ALTER TABLE kingdom_decorations
  ADD COLUMN IF NOT EXISTS spatial_revision bigint NOT NULL
  DEFAULT nextval('kingdom_spatial_revision_seq');

ALTER TABLE kingdoms
  ALTER COLUMN spatial_revision SET DEFAULT nextval('kingdom_spatial_revision_seq');
ALTER TABLE kingdom_cots
  ALTER COLUMN spatial_revision SET DEFAULT nextval('kingdom_spatial_revision_seq');
ALTER TABLE kingdom_decorations
  ALTER COLUMN spatial_revision SET DEFAULT nextval('kingdom_spatial_revision_seq');

UPDATE kingdoms SET spatial_revision = nextval('kingdom_spatial_revision_seq')
WHERE spatial_revision IS NULL;
UPDATE kingdom_cots SET spatial_revision = nextval('kingdom_spatial_revision_seq')
WHERE spatial_revision IS NULL;
UPDATE kingdom_decorations SET spatial_revision = nextval('kingdom_spatial_revision_seq')
WHERE spatial_revision IS NULL;

SELECT setval(
  'kingdom_spatial_revision_seq',
  GREATEST(
    (SELECT last_value FROM kingdom_spatial_revision_seq),
    COALESCE((SELECT max(spatial_revision) FROM kingdoms), 1),
    COALESCE((SELECT max(spatial_revision) FROM kingdom_cots), 1),
    COALESCE((SELECT max(spatial_revision) FROM kingdom_decorations), 1)
  ),
  true
);

ALTER TABLE kingdoms ALTER COLUMN spatial_revision SET NOT NULL;
ALTER TABLE kingdom_cots ALTER COLUMN spatial_revision SET NOT NULL;
ALTER TABLE kingdom_decorations ALTER COLUMN spatial_revision SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kingdoms_spatial_revision_valid'
  ) THEN
    ALTER TABLE kingdoms
      ADD CONSTRAINT kingdoms_spatial_revision_valid CHECK (spatial_revision > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kingdom_cots_spatial_revision_valid'
  ) THEN
    ALTER TABLE kingdom_cots
      ADD CONSTRAINT kingdom_cots_spatial_revision_valid CHECK (spatial_revision > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kingdom_decorations_spatial_revision_valid'
  ) THEN
    ALTER TABLE kingdom_decorations
      ADD CONSTRAINT kingdom_decorations_spatial_revision_valid CHECK (spatial_revision > 0);
  END IF;
END $$;
