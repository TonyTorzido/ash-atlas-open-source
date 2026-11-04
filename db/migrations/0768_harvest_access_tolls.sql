-- Player-owned harvest access, type tolls, durable mine claims, and quoted mine sessions.

ALTER TABLE repeatable_resource_nodes
  ADD COLUMN owner_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  ADD COLUMN harvest_access_mode text NULL,
  ADD COLUMN harvest_access_revision bigint NOT NULL DEFAULT 0 CHECK (harvest_access_revision >= 0),
  ADD COLUMN claimed_at timestamptz NULL;

ALTER TABLE repeatable_resource_nodes
  ADD CONSTRAINT repeatable_resource_nodes_harvest_access_shape CHECK (
    (
      owner_player_id IS NULL
      AND harvest_access_mode IS NULL
      AND claimed_at IS NULL
    )
    OR (
      owner_player_id IS NOT NULL
      AND harvest_access_mode IN ('private', 'public')
      AND claimed_at IS NOT NULL
    )
  );

CREATE INDEX repeatable_resource_nodes_owner_idx
  ON repeatable_resource_nodes (owner_player_id)
  WHERE owner_player_id IS NOT NULL;

ALTER TABLE city_structures
  ADD COLUMN harvest_access_mode text NULL,
  ADD COLUMN harvest_access_revision bigint NOT NULL DEFAULT 0 CHECK (harvest_access_revision >= 0);

UPDATE city_structures
SET harvest_access_mode = 'private'
WHERE structure_type = 'oil_well' AND harvest_access_mode IS NULL;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_harvest_access_shape CHECK (
    (
      structure_type = 'oil_well'
      AND harvest_access_mode IN ('private', 'public')
    )
    OR (
      structure_type <> 'oil_well'
      AND harvest_access_mode IS NULL
    )
  );

CREATE TABLE player_harvest_toll_settings (
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  harvest_type text NOT NULL CHECK (
    harvest_type IN ('stone_mine', 'coal_mine', 'iron_mine', 'oil_well')
  ),
  toll_gold bigint NOT NULL DEFAULT 0 CHECK (toll_gold BETWEEN 0 AND 9999999999999999),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_player_id, harvest_type)
);

DROP TRIGGER IF EXISTS player_harvest_toll_settings_set_updated_at
  ON player_harvest_toll_settings;
CREATE TRIGGER player_harvest_toll_settings_set_updated_at
BEFORE UPDATE ON player_harvest_toll_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE repeatable_resource_claim_operations (
  operation_key text PRIMARY KEY,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  node_id uuid NOT NULL REFERENCES repeatable_resource_nodes(id) ON DELETE RESTRICT,
  result jsonb NULL CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NULL,
  UNIQUE (actor_player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE TABLE harvest_toll_operations (
  operation_key text PRIMARY KEY,
  harvest_type text NOT NULL CHECK (
    harvest_type IN ('stone_mine', 'coal_mine', 'iron_mine', 'oil_well')
  ),
  asset_id text NOT NULL CHECK (length(asset_id) BETWEEN 1 AND 160),
  payer_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  recipient_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  toll_gold bigint NOT NULL CHECK (toll_gold > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE repeatable_resource_sessions
  ADD COLUMN quoted_owner_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  ADD COLUMN quoted_access_mode text NULL CHECK (quoted_access_mode IN ('private', 'public')),
  ADD COLUMN quoted_toll_gold bigint NOT NULL DEFAULT 0 CHECK (quoted_toll_gold >= 0),
  ADD COLUMN quoted_access_revision bigint NOT NULL DEFAULT 0 CHECK (quoted_access_revision >= 0),
  ADD COLUMN quoted_toll_revision bigint NOT NULL DEFAULT 0 CHECK (quoted_toll_revision >= 0);

ALTER TABLE repeatable_resource_sessions
  ADD CONSTRAINT repeatable_resource_sessions_toll_quote_shape CHECK (
    (quoted_owner_player_id IS NULL AND quoted_access_mode IS NULL AND quoted_toll_gold = 0)
    OR
    (quoted_owner_player_id IS NOT NULL AND quoted_access_mode IN ('private', 'public'))
  );

COMMENT ON TABLE player_harvest_toll_settings IS
  'Owner-wide Gold tolls by harvestable type; individual assets retain private/public access.';
COMMENT ON TABLE harvest_toll_operations IS
  'Exactly-once public harvest toll receipts paired with immutable wallet operations.';
