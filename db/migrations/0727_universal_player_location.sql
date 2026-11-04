-- One durable source of truth for world/interior location. Feature presence
-- tables remain domain-session records but are no longer location authority.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS location_kind text NOT NULL DEFAULT 'world',
  ADD COLUMN IF NOT EXISTS location_type text NULL,
  ADD COLUMN IF NOT EXISTS location_id text NULL,
  ADD COLUMN IF NOT EXISTS location_instance_id text NULL,
  ADD COLUMN IF NOT EXISTS location_space_id text NULL,
  ADD COLUMN IF NOT EXISTS location_local_x double precision NULL,
  ADD COLUMN IF NOT EXISTS location_local_y double precision NULL,
  ADD COLUMN IF NOT EXISTS location_facing double precision NULL,
  ADD COLUMN IF NOT EXISTS location_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_portal_id text NULL,
  ADD COLUMN IF NOT EXISTS last_transition_request_id text NULL,
  ADD COLUMN IF NOT EXISTS last_transition_request_hash text NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT player_id
    FROM (
      SELECT player_id FROM player_manor_presence
      UNION ALL SELECT player_id FROM salon_presence
      UNION ALL SELECT player_id FROM cistern_warrens_presence
    ) active_presence
    GROUP BY player_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'universal location migration found a player in multiple legacy presence tables';
  END IF;
END $$;

UPDATE players player
SET location_kind = 'interior',
    location_type = 'manor',
    location_id = presence.manor_id::text,
    location_instance_id = 'manor:' || presence.manor_id::text,
    location_space_id = 'manor_main_room',
    location_local_x = COALESCE(presence.local_position_x, 500),
    location_local_y = COALESCE(presence.local_position_y, 790),
    location_revision = GREATEST(player.location_revision, 1),
    last_portal_id = 'manor:' || presence.manor_id::text || ':world-to-foyer'
FROM player_manor_presence presence
WHERE player.id = presence.player_id
  AND player.location_kind = 'world';

UPDATE players player
SET location_kind = 'interior',
    location_type = 'salon',
    location_id = presence.salon_structure_id::text,
    location_instance_id = 'salon:' || presence.salon_structure_id::text,
    location_space_id = 'salon_main_room',
    location_local_x = presence.local_x,
    location_local_y = presence.local_y,
    location_revision = GREATEST(player.location_revision, 1),
    last_portal_id = 'salon:' || presence.salon_structure_id::text || ':world-to-main'
FROM salon_presence presence
WHERE player.id = presence.player_id
  AND player.location_kind = 'world';

UPDATE players player
SET location_kind = 'interior',
    location_type = 'cistern_warrens',
    location_id = presence.sewer_structure_id::text,
    location_instance_id = 'sewer:' || presence.sewer_structure_id::text,
    location_space_id = 'sewer_depths',
    location_local_x = presence.local_x,
    location_local_y = presence.local_y,
    location_revision = GREATEST(player.location_revision, 1),
    last_portal_id = 'sewer:' || presence.sewer_structure_id::text || ':world-to-entrance'
FROM cistern_warrens_presence presence
WHERE player.id = presence.player_id
  AND player.location_kind = 'world';

ALTER TABLE players
  DROP CONSTRAINT IF EXISTS players_location_kind_check,
  DROP CONSTRAINT IF EXISTS players_location_shape_check,
  DROP CONSTRAINT IF EXISTS players_location_revision_check,
  DROP CONSTRAINT IF EXISTS players_transition_request_pair_check;

ALTER TABLE players
  ADD CONSTRAINT players_location_kind_check CHECK (location_kind IN ('world', 'interior')),
  ADD CONSTRAINT players_location_revision_check CHECK (location_revision >= 0),
  ADD CONSTRAINT players_transition_request_pair_check CHECK (
    (last_transition_request_id IS NULL) = (last_transition_request_hash IS NULL)
    AND (last_transition_request_id IS NULL OR length(last_transition_request_id) BETWEEN 1 AND 128)
    AND (last_transition_request_hash IS NULL OR length(last_transition_request_hash) = 64)
  ),
  ADD CONSTRAINT players_location_shape_check CHECK (
    (
      location_kind = 'world'
      AND location_type IS NULL AND location_id IS NULL
      AND location_instance_id IS NULL AND location_space_id IS NULL
      AND location_local_x IS NULL AND location_local_y IS NULL
      AND location_facing IS NULL
    ) OR (
      location_kind = 'interior'
      AND location_type IN ('manor', 'salon', 'cistern_warrens')
      AND length(location_id) > 0
      AND length(location_instance_id) > 0
      AND length(location_space_id) > 0
      AND location_local_x > '-Infinity'::double precision
      AND location_local_x < 'Infinity'::double precision
      AND location_local_y > '-Infinity'::double precision
      AND location_local_y < 'Infinity'::double precision
      AND (
        location_facing IS NULL OR (
          location_facing > '-Infinity'::double precision
          AND location_facing < 'Infinity'::double precision
        )
      )
    )
  );

CREATE INDEX IF NOT EXISTS players_location_instance_space_idx
  ON players (location_instance_id, location_space_id)
  WHERE location_kind = 'interior';

COMMENT ON COLUMN players.location_kind IS
  'Canonical durable world/interior discriminator. Feature presence tables are domain state only.';
COMMENT ON COLUMN players.location_space_id IS
  'Active independently rendered room/floor inside location_instance_id.';
