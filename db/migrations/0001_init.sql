CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flags (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  package_id text NULL,
  elevation_m double precision NULL,
  terrain_class text NULL,
  biome text NULL,
  ecoregion text NULL,
  claim_radius_m double precision NOT NULL,
  environment_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  geom geometry(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS flags_geom_gix ON flags USING gist (geom);
CREATE INDEX IF NOT EXISTS flags_owner_id_idx ON flags (owner_id);
CREATE INDEX IF NOT EXISTS flags_created_at_idx ON flags (created_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS flags_set_updated_at ON flags;
CREATE TRIGGER flags_set_updated_at
BEFORE UPDATE ON flags
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

