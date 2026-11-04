CREATE TABLE IF NOT EXISTS xoral_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_tree_entity_id text NOT NULL UNIQUE,
  population_zone_id text NOT NULL,
  population_generation_id uuid NOT NULL,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  combat_entity_id text NOT NULL UNIQUE,
  region_code text NOT NULL,
  zone_id text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  status text NOT NULL DEFAULT 'dormant'
    CHECK (status IN ('dormant','starting','active','settling','defeated','cancelled')),
  locked_party_id text NULL,
  locked_participant_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluded_participant_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  defeat_candidate jsonb NULL,
  activated_at timestamptz NULL,
  settled_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(locked_participant_ids) = 'array'),
  CHECK (jsonb_typeof(excluded_participant_ids) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS xoral_events_one_live_per_generation_idx
  ON xoral_events (population_zone_id, population_generation_id)
  WHERE status IN ('dormant','starting','active','settling');

CREATE INDEX IF NOT EXISTS xoral_events_live_idx
  ON xoral_events (status, created_at)
  WHERE status IN ('dormant','starting','active','settling');

DROP TRIGGER IF EXISTS xoral_events_set_updated_at ON xoral_events;
CREATE TRIGGER xoral_events_set_updated_at
BEFORE UPDATE ON xoral_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS xoral_event_rewards (
  event_id uuid NOT NULL REFERENCES xoral_events(event_id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  authoritative_damage bigint NOT NULL CHECK (authoritative_damage > 0),
  ring_definition_id text NOT NULL
    CHECK (ring_definition_id IN ('chopping_ring','mining_ring','attack_ring')),
  ring_delivery text NOT NULL CHECK (ring_delivery IN ('inventory','ground')),
  gold_amount bigint NOT NULL DEFAULT 10000 CHECK (gold_amount = 10000),
  xp_amount integer NOT NULL CHECK (xp_amount >= 0),
  class_xp_amount integer NOT NULL CHECK (class_xp_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, player_id)
);

CREATE TABLE IF NOT EXISTS xoral_ring_drops (
  drop_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES xoral_events(event_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  ring_definition_id text NOT NULL
    CHECK (ring_definition_id IN ('chopping_ring','mining_ring','attack_ring')),
  region_code text NOT NULL,
  zone_id text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','picked_up')),
  created_at timestamptz NOT NULL DEFAULT now(),
  picked_up_at timestamptz NULL,
  UNIQUE (event_id, owner_player_id)
);

CREATE INDEX IF NOT EXISTS xoral_ring_drops_owner_available_idx
  ON xoral_ring_drops (owner_player_id, created_at)
  WHERE status = 'available';
