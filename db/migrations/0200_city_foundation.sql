CREATE TABLE IF NOT EXISTS cities (
  id uuid PRIMARY KEY,
  world_settlement_id text NOT NULL,
  world_settlement_source text NOT NULL,
  world_source_settlement_id text NOT NULL,
  name text NOT NULL,
  country_code text NOT NULL,
  region_code text NULL,
  founder_player_id text NOT NULL REFERENCES players(id),
  founding_request_id text NOT NULL,
  hall_lat double precision NOT NULL,
  hall_lon double precision NOT NULL,
  hall_geom geometry(Point, 4326) NOT NULL,
  founding_annex_radius_m double precision NOT NULL,
  active boolean NOT NULL DEFAULT true,
  jumpable boolean NOT NULL DEFAULT true,
  rebuild_available_at timestamptz NULL,
  inactive_reason text NULL,
  ended_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cities_world_settlement_id_nonempty CHECK (length(btrim(world_settlement_id)) > 0),
  CONSTRAINT cities_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT cities_country_code_nonempty CHECK (length(btrim(country_code)) > 0),
  CONSTRAINT cities_hall_lat_valid CHECK (hall_lat BETWEEN -90 AND 90),
  CONSTRAINT cities_hall_lon_valid CHECK (hall_lon BETWEEN -180 AND 180),
  CONSTRAINT cities_founding_annex_radius_positive CHECK (founding_annex_radius_m > 0),
  CONSTRAINT cities_founder_request_unique UNIQUE (founder_player_id, founding_request_id),
  CONSTRAINT cities_inactive_reason_valid CHECK (inactive_reason IS NULL OR inactive_reason IN ('destroyed', 'abandoned')),
  CONSTRAINT cities_lifecycle_consistent CHECK (
    (active AND inactive_reason IS NULL AND ended_at IS NULL AND rebuild_available_at IS NULL) OR
    (NOT active AND inactive_reason IS NOT NULL AND ended_at IS NOT NULL AND rebuild_available_at IS NOT NULL)
  )
);

-- Isolated settlement databases may already contain the pre-integration 0016 schema.
-- Upgrade that schema in place; fresh databases receive the same final shape here.
ALTER TABLE cities ADD COLUMN IF NOT EXISTS inactive_reason text NULL;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS ended_at timestamptz NULL;

UPDATE cities
SET inactive_reason = NULL, ended_at = NULL, rebuild_available_at = NULL
WHERE active AND (inactive_reason IS NOT NULL OR ended_at IS NOT NULL OR rebuild_available_at IS NOT NULL);

UPDATE cities
SET inactive_reason = COALESCE(inactive_reason, 'abandoned'),
    ended_at = COALESCE(ended_at, updated_at),
    rebuild_available_at = COALESCE(rebuild_available_at, updated_at + interval '7 days')
WHERE NOT active;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass AND conname = 'cities_inactive_reason_valid'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_inactive_reason_valid
      CHECK (inactive_reason IS NULL OR inactive_reason IN ('destroyed', 'abandoned'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass AND conname = 'cities_lifecycle_consistent'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_lifecycle_consistent CHECK (
      (active AND inactive_reason IS NULL AND ended_at IS NULL AND rebuild_available_at IS NULL) OR
      (NOT active AND inactive_reason IS NOT NULL AND ended_at IS NOT NULL AND rebuild_available_at IS NOT NULL)
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS cities_one_active_per_settlement_idx
  ON cities (world_settlement_id)
  WHERE active;
CREATE INDEX IF NOT EXISTS cities_founder_player_id_idx ON cities (founder_player_id);
CREATE INDEX IF NOT EXISTS cities_hall_geom_gix ON cities USING gist (hall_geom);
CREATE INDEX IF NOT EXISTS cities_rebuild_cooldown_idx
  ON cities (world_settlement_id, rebuild_available_at)
  WHERE NOT active;

DROP TRIGGER IF EXISTS cities_set_updated_at ON cities;
CREATE TRIGGER cities_set_updated_at
BEFORE UPDATE ON cities
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS city_id uuid NULL REFERENCES cities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS flags_city_id_idx ON flags (city_id);

CREATE TABLE IF NOT EXISTS city_memberships (
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz NULL,
  PRIMARY KEY (city_id, player_id),
  CONSTRAINT city_memberships_role_valid CHECK (role IN ('founder', 'member')),
  CONSTRAINT city_memberships_lifecycle_valid CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE INDEX IF NOT EXISTS city_memberships_player_active_idx
  ON city_memberships (player_id, joined_at DESC)
  WHERE left_at IS NULL;

-- Backfill authoritative founder membership for schemas previously created by 0016.
INSERT INTO city_memberships (city_id, player_id, role, joined_at, left_at)
SELECT id, founder_player_id, 'founder', created_at,
       CASE WHEN active THEN NULL ELSE COALESCE(ended_at, updated_at) END
FROM cities
ON CONFLICT (city_id, player_id) DO NOTHING;
