CREATE TABLE IF NOT EXISTS kingdoms (
  id uuid PRIMARY KEY,
  normalized_name text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text NULL,
  emblem_key text NULL,
  founder_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  leader_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active',
  level integer NOT NULL DEFAULT 1,
  current_xp bigint NOT NULL DEFAULT 0,
  lifetime_xp bigint NOT NULL DEFAULT 0,
  level_definition_version integer NOT NULL DEFAULT 1,
  founding_request_id text NOT NULL,
  dissolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdoms_normalized_name_valid CHECK (
    normalized_name = lower(normalized_name) AND
    char_length(normalized_name) BETWEEN 3 AND 40 AND
    normalized_name ~ '^[a-z0-9]+(?:[ _-][a-z0-9]+)*$'
  ),
  CONSTRAINT kingdoms_display_name_valid CHECK (char_length(btrim(display_name)) BETWEEN 3 AND 40),
  CONSTRAINT kingdoms_description_valid CHECK (description IS NULL OR char_length(description) <= 500),
  CONSTRAINT kingdoms_emblem_valid CHECK (emblem_key IS NULL OR char_length(emblem_key) BETWEEN 1 AND 80),
  CONSTRAINT kingdoms_status_valid CHECK (status IN ('active', 'dissolved', 'archived')),
  CONSTRAINT kingdoms_level_valid CHECK (level BETWEEN 1 AND 5),
  CONSTRAINT kingdoms_xp_valid CHECK (current_xp >= 0 AND lifetime_xp >= current_xp),
  CONSTRAINT kingdoms_lifecycle_valid CHECK (
    (status = 'active' AND dissolved_at IS NULL) OR
    (status <> 'active' AND dissolved_at IS NOT NULL)
  ),
  CONSTRAINT kingdoms_founder_request_unique UNIQUE (founder_player_id, founding_request_id)
);

DROP TRIGGER IF EXISTS kingdoms_set_updated_at ON kingdoms;
CREATE TRIGGER kingdoms_set_updated_at
BEFORE UPDATE ON kingdoms
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS kingdoms_status_created_idx ON kingdoms (status, created_at DESC);
CREATE INDEX IF NOT EXISTS kingdoms_leader_active_idx ON kingdoms (leader_player_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS kingdom_seats (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  territory_radius_m double precision NOT NULL,
  terrain_class text NULL,
  biome text NULL,
  ecoregion text NULL,
  elevation_m double precision NULL,
  elevation_band text NULL,
  slope double precision NULL,
  slope_band text NULL,
  is_land boolean NOT NULL,
  is_saltwater boolean NOT NULL,
  inside_major_lake boolean NOT NULL,
  world_release_id text NULL,
  world_release_version text NULL,
  world_package_id text NULL,
  environment_schema_version text NULL,
  environment_source_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  environment_rules_version integer NOT NULL,
  environment_modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  environment_lookup_at timestamptz NOT NULL,
  construction_state text NOT NULL,
  completed_under_free_construction boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  archived_at timestamptz NULL,
  CONSTRAINT kingdom_seats_position_valid CHECK (lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180),
  CONSTRAINT kingdom_seats_radius_valid CHECK (territory_radius_m BETWEEN 25 AND 5000),
  CONSTRAINT kingdom_seats_land_valid CHECK (is_land AND NOT is_saltwater AND NOT inside_major_lake),
  CONSTRAINT kingdom_seats_environment_rules_valid CHECK (environment_rules_version > 0),
  CONSTRAINT kingdom_seats_construction_state_valid CHECK (construction_state IN ('under_construction', 'complete')),
  CONSTRAINT kingdom_seats_status_valid CHECK (status IN ('active', 'archived', 'relocating')),
  CONSTRAINT kingdom_seats_completion_valid CHECK (
    (construction_state = 'complete' AND completed_at IS NOT NULL) OR
    (construction_state = 'under_construction' AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS kingdom_seats_one_active_per_kingdom_idx
  ON kingdom_seats (kingdom_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS kingdom_seats_geom_active_gix
  ON kingdom_seats USING gist (geom) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS kingdom_seats_status_created_idx ON kingdom_seats (status, created_at DESC);

CREATE TABLE IF NOT EXISTS kingdom_memberships (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT now(),
  perk_qualified_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  ended_by_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  end_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_memberships_role_valid CHECK (role IN ('leader', 'officer', 'member')),
  CONSTRAINT kingdom_memberships_status_valid CHECK (status IN ('active', 'left', 'removed', 'banned')),
  CONSTRAINT kingdom_memberships_lifecycle_valid CHECK (
    (status = 'active' AND ended_at IS NULL) OR
    (status <> 'active' AND ended_at IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS kingdom_memberships_set_updated_at ON kingdom_memberships;
CREATE TRIGGER kingdom_memberships_set_updated_at
BEFORE UPDATE ON kingdom_memberships
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS kingdom_memberships_one_active_per_player_idx
  ON kingdom_memberships (player_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS kingdom_memberships_one_active_pair_idx
  ON kingdom_memberships (kingdom_id, player_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS kingdom_memberships_one_leader_idx
  ON kingdom_memberships (kingdom_id) WHERE status = 'active' AND role = 'leader';
CREATE INDEX IF NOT EXISTS kingdom_memberships_kingdom_active_idx
  ON kingdom_memberships (kingdom_id, joined_at, player_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS kingdom_memberships_player_history_idx
  ON kingdom_memberships (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kingdom_memberships_bans_idx
  ON kingdom_memberships (kingdom_id, player_id, ended_at DESC) WHERE status = 'banned';

CREATE TABLE IF NOT EXISTS kingdom_invitations (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  target_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  invited_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',
  request_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  responded_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_invitations_status_valid CHECK (
    status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'revoked')
  ),
  CONSTRAINT kingdom_invitations_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT kingdom_invitations_response_valid CHECK (
    (status = 'pending' AND responded_at IS NULL) OR
    (status <> 'pending' AND responded_at IS NOT NULL)
  ),
  CONSTRAINT kingdom_invitations_inviter_request_unique UNIQUE (invited_by_player_id, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS kingdom_invitations_one_pending_pair_idx
  ON kingdom_invitations (kingdom_id, target_player_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS kingdom_invitations_target_pending_idx
  ON kingdom_invitations (target_player_id, expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS kingdom_invitations_kingdom_status_idx
  ON kingdom_invitations (kingdom_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS kingdom_chat_messages (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  sender_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_chat_content_valid CHECK (char_length(btrim(content)) BETWEEN 1 AND 500),
  CONSTRAINT kingdom_chat_sender_request_unique UNIQUE (sender_player_id, request_id)
);

CREATE INDEX IF NOT EXISTS kingdom_chat_messages_history_idx
  ON kingdom_chat_messages (kingdom_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS kingdom_chat_mutes (
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  muted_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  muted_until timestamptz NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kingdom_id, player_id),
  CONSTRAINT kingdom_chat_mutes_reason_valid CHECK (reason IS NULL OR char_length(reason) <= 240)
);

DROP TRIGGER IF EXISTS kingdom_chat_mutes_set_updated_at ON kingdom_chat_mutes;
CREATE TRIGGER kingdom_chat_mutes_set_updated_at
BEFORE UPDATE ON kingdom_chat_mutes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS kingdom_treasury_balances (
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  resource_type text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  quantity bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kingdom_id, resource_type, variant),
  CONSTRAINT kingdom_treasury_quantity_valid CHECK (quantity >= 0)
);

CREATE TABLE IF NOT EXISTS kingdom_donations (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  donor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  resource_type text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  quantity integer NOT NULL,
  player_balance_before integer NOT NULL,
  player_balance_after integer NOT NULL,
  treasury_balance_before bigint NOT NULL,
  treasury_balance_after bigint NOT NULL,
  kingdom_xp_granted integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_donations_quantity_valid CHECK (quantity > 0),
  CONSTRAINT kingdom_donations_player_balance_valid CHECK (
    player_balance_before >= quantity AND player_balance_after = player_balance_before - quantity
  ),
  CONSTRAINT kingdom_donations_treasury_balance_valid CHECK (
    treasury_balance_before >= 0 AND treasury_balance_after = treasury_balance_before + quantity
  ),
  CONSTRAINT kingdom_donations_xp_valid CHECK (kingdom_xp_granted >= 0),
  CONSTRAINT kingdom_donations_donor_request_unique UNIQUE (donor_player_id, request_id)
);

CREATE INDEX IF NOT EXISTS kingdom_donations_kingdom_history_idx
  ON kingdom_donations (kingdom_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS kingdom_donations_donor_history_idx
  ON kingdom_donations (donor_player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kingdom_xp_ledger (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  source_type text NOT NULL,
  source_id text NULL,
  actor_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  xp_delta integer NOT NULL,
  xp_before bigint NOT NULL,
  xp_after bigint NOT NULL,
  level_before integer NOT NULL,
  level_after integer NOT NULL,
  level_definition_version integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_xp_ledger_source_valid CHECK (source_type IN ('donation', 'construction', 'development')),
  CONSTRAINT kingdom_xp_ledger_delta_valid CHECK (xp_delta > 0 AND xp_after = xp_before + xp_delta),
  CONSTRAINT kingdom_xp_ledger_level_valid CHECK (
    level_before BETWEEN 1 AND 5 AND level_after BETWEEN level_before AND 5
  ),
  CONSTRAINT kingdom_xp_ledger_request_unique UNIQUE (kingdom_id, request_id)
);

CREATE INDEX IF NOT EXISTS kingdom_xp_ledger_history_idx
  ON kingdom_xp_ledger (kingdom_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS kingdom_cots (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  placed_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  rotation double precision NOT NULL DEFAULT 0,
  footprint_radius_m double precision NOT NULL DEFAULT 2.5,
  status text NOT NULL DEFAULT 'active',
  completed_under_free_construction boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  CONSTRAINT kingdom_cots_position_valid CHECK (lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180),
  CONSTRAINT kingdom_cots_rotation_valid CHECK (rotation BETWEEN -360 AND 360),
  CONSTRAINT kingdom_cots_footprint_valid CHECK (footprint_radius_m > 0),
  CONSTRAINT kingdom_cots_status_valid CHECK (status IN ('active', 'packed', 'archived')),
  CONSTRAINT kingdom_cots_owner_request_unique UNIQUE (owner_player_id, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS kingdom_cots_one_active_per_member_idx
  ON kingdom_cots (owner_player_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS kingdom_cots_kingdom_active_idx
  ON kingdom_cots (kingdom_id, created_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS kingdom_cots_geom_active_gix
  ON kingdom_cots USING gist (geom) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS kingdom_decoration_definitions (
  type_id text PRIMARY KEY,
  display_name text NOT NULL,
  footprint_radius_m double precision NOT NULL,
  ownership_type text NOT NULL,
  required_kingdom_level integer NOT NULL,
  capacity_cost integer NOT NULL,
  future_material_cost jsonb NOT NULL DEFAULT '[]'::jsonb,
  intended_construction_seconds integer NOT NULL,
  members_may_place boolean NOT NULL,
  officers_only boolean NOT NULL,
  active boolean NOT NULL DEFAULT true,
  rules_version integer NOT NULL DEFAULT 1,
  CONSTRAINT kingdom_decoration_definitions_footprint_valid CHECK (footprint_radius_m > 0),
  CONSTRAINT kingdom_decoration_definitions_ownership_valid CHECK (ownership_type IN ('personal', 'kingdom', 'choice')),
  CONSTRAINT kingdom_decoration_definitions_level_valid CHECK (required_kingdom_level BETWEEN 1 AND 5),
  CONSTRAINT kingdom_decoration_definitions_capacity_valid CHECK (capacity_cost > 0),
  CONSTRAINT kingdom_decoration_definitions_time_valid CHECK (intended_construction_seconds >= 0)
);

INSERT INTO kingdom_decoration_definitions (
  type_id, display_name, footprint_radius_m, ownership_type, required_kingdom_level,
  capacity_cost, future_material_cost, intended_construction_seconds,
  members_may_place, officers_only, rules_version
) VALUES
  ('banner', 'Banner', 2, 'choice', 1, 1, '[{"resourceType":"wood","quantity":5}]', 30, true, false, 1),
  ('campfire', 'Campfire', 3, 'choice', 1, 2, '[{"resourceType":"wood","quantity":8},{"resourceType":"stone","quantity":4}]', 45, true, false, 1),
  ('table', 'Table', 2.5, 'personal', 1, 2, '[{"resourceType":"wood","quantity":10}]', 60, true, false, 1),
  ('crate', 'Supply Crate', 2, 'choice', 1, 1, '[{"resourceType":"wood","quantity":6}]', 30, true, false, 1),
  ('training_post', 'Training Post', 3, 'kingdom', 3, 3, '[{"resourceType":"wood","quantity":12},{"resourceType":"stone","quantity":6}]', 90, false, true, 1)
ON CONFLICT (type_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  footprint_radius_m = EXCLUDED.footprint_radius_m,
  ownership_type = EXCLUDED.ownership_type,
  required_kingdom_level = EXCLUDED.required_kingdom_level,
  capacity_cost = EXCLUDED.capacity_cost,
  future_material_cost = EXCLUDED.future_material_cost,
  intended_construction_seconds = EXCLUDED.intended_construction_seconds,
  members_may_place = EXCLUDED.members_may_place,
  officers_only = EXCLUDED.officers_only,
  rules_version = EXCLUDED.rules_version;

CREATE TABLE IF NOT EXISTS kingdom_decorations (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  type_id text NOT NULL REFERENCES kingdom_decoration_definitions(type_id) ON DELETE RESTRICT,
  placed_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  personal_owner_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  kingdom_owned boolean NOT NULL,
  request_id text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  rotation double precision NOT NULL DEFAULT 0,
  footprint_radius_m double precision NOT NULL,
  capacity_cost integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  completed_under_free_construction boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  CONSTRAINT kingdom_decorations_position_valid CHECK (lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180),
  CONSTRAINT kingdom_decorations_rotation_valid CHECK (rotation BETWEEN -360 AND 360),
  CONSTRAINT kingdom_decorations_footprint_valid CHECK (footprint_radius_m > 0),
  CONSTRAINT kingdom_decorations_capacity_valid CHECK (capacity_cost > 0),
  CONSTRAINT kingdom_decorations_ownership_valid CHECK (
    (kingdom_owned AND personal_owner_player_id IS NULL) OR
    (NOT kingdom_owned AND personal_owner_player_id IS NOT NULL)
  ),
  CONSTRAINT kingdom_decorations_status_valid CHECK (status IN ('active', 'packed', 'archived', 'removed')),
  CONSTRAINT kingdom_decorations_placer_request_unique UNIQUE (placed_by_player_id, request_id)
);

DROP TRIGGER IF EXISTS kingdom_decorations_set_updated_at ON kingdom_decorations;
CREATE TRIGGER kingdom_decorations_set_updated_at
BEFORE UPDATE ON kingdom_decorations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS kingdom_decorations_kingdom_active_idx
  ON kingdom_decorations (kingdom_id, created_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS kingdom_decorations_owner_active_idx
  ON kingdom_decorations (personal_owner_player_id, created_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS kingdom_decorations_geom_active_gix
  ON kingdom_decorations USING gist (geom) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS kingdom_requests (
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  kingdom_id uuid NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_player_id, request_id),
  CONSTRAINT kingdom_requests_operation_valid CHECK (char_length(operation) BETWEEN 1 AND 80),
  CONSTRAINT kingdom_requests_hash_valid CHECK (char_length(request_hash) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS kingdom_requests_created_idx ON kingdom_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS kingdom_audit_events (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  actor_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  target_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  entity_type text NULL,
  entity_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_audit_event_type_valid CHECK (char_length(event_type) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS kingdom_audit_events_history_idx
  ON kingdom_audit_events (kingdom_id, created_at DESC, id DESC);
