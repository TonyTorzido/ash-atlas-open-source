ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS controller_kind text NOT NULL DEFAULT 'player',
  ADD COLUMN IF NOT EXISTS culture text NOT NULL DEFAULT 'human',
  ADD COLUMN IF NOT EXISTS banner_color text NOT NULL DEFAULT '#d83a3a';

ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_controller_kind_valid;
ALTER TABLE cities ADD CONSTRAINT cities_controller_kind_valid
  CHECK (controller_kind IN ('player', 'npc'));
ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_culture_valid;
ALTER TABLE cities ADD CONSTRAINT cities_culture_valid
  CHECK (culture IN ('human', 'goblin'));
ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_banner_color_valid;
ALTER TABLE cities ADD CONSTRAINT cities_banner_color_valid
  CHECK (banner_color ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_npc_culture_valid;
ALTER TABLE cities ADD CONSTRAINT cities_npc_culture_valid CHECK (
  (controller_kind = 'player' AND culture = 'human')
  OR (controller_kind = 'npc' AND culture = 'goblin')
);

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS presentation_color text NULL,
  ADD COLUMN IF NOT EXISTS system_controlled boolean NOT NULL DEFAULT false;

ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_presentation_color_valid;
ALTER TABLE flags ADD CONSTRAINT flags_presentation_color_valid
  CHECK (presentation_color IS NULL OR presentation_color ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_system_control_valid;
ALTER TABLE flags ADD CONSTRAINT flags_system_control_valid CHECK (
  NOT system_controlled
  OR (control_type IN ('city', 'city_seat') AND city_id IS NOT NULL)
);

-- Tower upgrades remain player-personal only. This exception is solely for
-- system-authored NPC city territory created directly by the server.
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_tower_personal_check;
ALTER TABLE flags ADD CONSTRAINT flags_tower_personal_check CHECK (
  reinforcement_level <> 3
  OR (
    anchor_kind = 'flag'
    AND (
      (control_type = 'personal' AND city_id IS NULL AND kingdom_id IS NULL AND NOT system_controlled)
      OR (control_type IN ('city', 'city_seat') AND city_id IS NOT NULL AND kingdom_id IS NULL AND system_controlled)
    )
  )
);

CREATE TABLE IF NOT EXISTS goblin_village_spawns (
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  center_lat double precision NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lon double precision NOT NULL CHECK (center_lon BETWEEN -180 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, request_id),
  UNIQUE (city_id)
);

CREATE TABLE IF NOT EXISTS npc_city_player_relations (
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  relation text NOT NULL DEFAULT 'enemy' CHECK (relation = 'enemy'),
  first_hostile_request_id text NOT NULL CHECK (length(first_hostile_request_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, player_id),
  UNIQUE (player_id, first_hostile_request_id)
);

CREATE TABLE IF NOT EXISTS npc_city_defender_slots (
  defender_id uuid PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('basic', 'warrior', 'archer', 'healer')),
  presentation_key text NOT NULL CHECK (presentation_key IN (
    'goblin', 'goblin_warrior', 'goblin_archer', 'goblin_healer'
  )),
  post_kind text NOT NULL CHECK (post_kind IN ('hall', 'market', 'tower')),
  post_flag_id uuid NULL REFERENCES flags(id) ON DELETE RESTRICT,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  region_code text NULL,
  pack_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, presentation_key, post_kind, lat, lon),
  CHECK ((post_kind = 'tower') = (post_flag_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS npc_city_defender_slots_city_idx
  ON npc_city_defender_slots (city_id, defender_id);

CREATE TABLE IF NOT EXISTS goblin_market_sales (
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  account_id text NOT NULL,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  market_structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  item_kind text NOT NULL CHECK (item_kind IN ('resource', 'equipment', 'backpack')),
  item_identity text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  offer_gold bigint NOT NULL CHECK (offer_gold > 0),
  result jsonb NULL CHECK (result IS NULL OR octet_length(result::text) <= 524288),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  PRIMARY KEY (player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

COMMENT ON COLUMN cities.controller_kind IS
  'Presentation and authority discriminator; player is the retained/default city behavior.';
COMMENT ON COLUMN flags.system_controlled IS
  'True only for server-authored NPC organization flags; never set by the player upgrade path.';

CREATE OR REPLACE FUNCTION capture_weekly_city_founding()
RETURNS trigger AS $$
BEGIN
  IF NEW.controller_kind = 'player' THEN
    INSERT INTO weekly_leaderboard_events (
      source_type, source_id, player_id, category, value, occurred_at, week_start
    ) VALUES (
      'city_founding', NEW.id::text, NEW.founder_player_id, 'cities_founded', 1,
      NEW.created_at, weekly_leaderboard_week_start(NEW.created_at)
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
