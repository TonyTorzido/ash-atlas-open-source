ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS world_id text NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS canonical_municipality_id text,
  ADD COLUMN IF NOT EXISTS seat_flag_id uuid NULL,
  ADD COLUMN IF NOT EXISTS spatial_revision bigint NOT NULL DEFAULT 0;

UPDATE cities
SET canonical_municipality_id = world_settlement_id
WHERE canonical_municipality_id IS NULL;

ALTER TABLE cities
  ALTER COLUMN canonical_municipality_id SET NOT NULL,
  ADD CONSTRAINT cities_world_id_nonempty CHECK (length(btrim(world_id)) > 0),
  ADD CONSTRAINT cities_canonical_municipality_id_nonempty
    CHECK (length(btrim(canonical_municipality_id)) > 0);

DROP INDEX IF EXISTS cities_one_active_per_settlement_idx;
CREATE UNIQUE INDEX cities_world_canonical_municipality_unique
  ON cities (world_id, canonical_municipality_id);

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS city_affiliated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS city_affiliated_by_player_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_city_affiliated_by_player_id_fkey'
  ) THEN
    ALTER TABLE flags
      ADD CONSTRAINT flags_city_affiliated_by_player_id_fkey
      FOREIGN KEY (city_affiliated_by_player_id) REFERENCES players(id) ON DELETE SET NULL;
  END IF;
END
$$;

WITH ranked AS (
  SELECT f.id, f.city_id,
         row_number() OVER (
           PARTITION BY f.city_id
           ORDER BY ST_Distance(f.geom::geography, c.hall_geom::geography), f.created_at, f.id
         ) AS city_rank
  FROM flags f
  JOIN cities c ON c.id = f.city_id
  WHERE f.city_id IS NOT NULL
)
UPDATE flags f
SET control_type = CASE WHEN ranked.city_rank = 1 THEN 'city_seat' ELSE 'city' END,
    original_owner_player_id = COALESCE(f.original_owner_player_id, f.owner_id),
    contributed_by_player_id = COALESCE(f.contributed_by_player_id, f.owner_id),
    original_personal_color = COALESCE(
      f.original_personal_color,
      player.display_color,
      '#d83a3a'
    ),
    city_affiliated_at = COALESCE(f.city_affiliated_at, f.created_at),
    city_affiliated_by_player_id = COALESCE(f.city_affiliated_by_player_id, f.owner_id)
FROM ranked, players player
WHERE f.id = ranked.id
  AND player.id = f.owner_id;

UPDATE cities c
SET seat_flag_id = seat.id,
    hall_lat = seat.lat,
    hall_lon = seat.lon,
    hall_geom = seat.geom
FROM flags seat
WHERE seat.city_id = c.id
  AND seat.control_type = 'city_seat'
  AND c.seat_flag_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cities WHERE seat_flag_id IS NULL) THEN
    RAISE EXCEPTION 'city territory redesign requires every retained city to have a source flag';
  END IF;
END
$$;

ALTER TABLE cities
  ALTER COLUMN seat_flag_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass AND conname = 'cities_seat_flag_id_fkey'
  ) THEN
    ALTER TABLE cities
      ADD CONSTRAINT cities_seat_flag_id_fkey
      FOREIGN KEY (seat_flag_id) REFERENCES flags(id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS cities_seat_flag_unique
  ON cities (seat_flag_id);
CREATE UNIQUE INDEX IF NOT EXISTS flags_one_city_seat_per_city
  ON flags (city_id) WHERE control_type = 'city_seat';
CREATE INDEX IF NOT EXISTS flags_city_controller_idx
  ON flags (city_id, control_type, id)
  WHERE control_type IN ('city', 'city_seat');

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_control_type_valid,
  ADD CONSTRAINT flags_control_type_valid
    CHECK (control_type IN ('personal', 'city', 'city_seat', 'kingdom', 'kingdom_seat')),
  DROP CONSTRAINT IF EXISTS flags_control_state_valid,
  ADD CONSTRAINT flags_control_state_valid CHECK (
    (
      control_type = 'personal'
      AND city_id IS NULL
      AND kingdom_id IS NULL
      AND city_affiliated_at IS NULL
      AND kingdom_affiliated_at IS NULL
    )
    OR
    (
      control_type IN ('city', 'city_seat')
      AND city_id IS NOT NULL
      AND kingdom_id IS NULL
      AND city_affiliated_at IS NOT NULL
      AND original_owner_player_id IS NOT NULL
      AND contributed_by_player_id IS NOT NULL
    )
    OR
    (
      control_type IN ('kingdom', 'kingdom_seat')
      AND city_id IS NULL
      AND kingdom_id IS NOT NULL
      AND kingdom_affiliated_at IS NOT NULL
      AND original_owner_player_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS city_memberships_one_active_per_player_idx
  ON city_memberships (player_id) WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS city_mutations (
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  operation text NOT NULL,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  flag_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_player_id, request_id),
  CONSTRAINT city_mutations_operation_valid CHECK (
    operation IN ('join_city', 'convert_city_flag')
  )
);

CREATE TABLE IF NOT EXISTS city_flag_affiliation_history (
  id uuid PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  flag_id uuid NOT NULL,
  flag_owner_player_id text NOT NULL,
  performed_by_player_id text NULL,
  action text NOT NULL,
  reason text NOT NULL,
  request_id text NULL,
  prior_city_id uuid NULL,
  resulting_city_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT city_flag_affiliation_history_action_valid CHECK (
    action IN ('seat_founded', 'affiliated', 'removed', 'pruned', 'flag_deleted', 'city_deactivated')
  ),
  CONSTRAINT city_flag_affiliation_history_reason_nonempty
    CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS city_flag_history_city_created_idx
  ON city_flag_affiliation_history (city_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS city_flag_history_flag_created_idx
  ON city_flag_affiliation_history (flag_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION enforce_organization_membership_exclusivity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'city_memberships' AND NEW.left_at IS NULL
     AND EXISTS (
       SELECT 1 FROM kingdom_memberships
       WHERE player_id = NEW.player_id AND status = 'active'
     ) THEN
    RAISE EXCEPTION 'Player already has an active Kingdom membership'
      USING ERRCODE = '23514', CONSTRAINT = 'organization_membership_exclusive';
  END IF;
  IF TG_TABLE_NAME = 'kingdom_memberships' AND NEW.status = 'active'
     AND EXISTS (
       SELECT 1 FROM city_memberships
       WHERE player_id = NEW.player_id AND left_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Player already has an active City membership'
      USING ERRCODE = '23514', CONSTRAINT = 'organization_membership_exclusive';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS city_memberships_organization_exclusive ON city_memberships;
CREATE CONSTRAINT TRIGGER city_memberships_organization_exclusive
AFTER INSERT OR UPDATE OF left_at ON city_memberships
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_organization_membership_exclusivity();

DROP TRIGGER IF EXISTS kingdom_memberships_organization_exclusive ON kingdom_memberships;
CREATE CONSTRAINT TRIGGER kingdom_memberships_organization_exclusive
AFTER INSERT OR UPDATE OF status ON kingdom_memberships
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_organization_membership_exclusivity();

CREATE OR REPLACE FUNCTION prevent_affiliated_flag_owner_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     AND (
       (OLD.city_id IS NOT NULL AND NEW.city_id IS NOT NULL)
       OR (OLD.kingdom_id IS NOT NULL AND NEW.kingdom_id IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'Organization affiliation must be cleared before flag ownership changes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
