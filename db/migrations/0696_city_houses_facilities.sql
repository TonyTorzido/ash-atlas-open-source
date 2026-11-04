-- City Houses become the sole authority for active city membership. This
-- forward-only migration preserves city, founder, flag, and inactive history.

ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS mayor_house_deadline timestamptz NULL,
  ADD COLUMN IF NOT EXISTS mayor_confirmed_at timestamptz NULL;

ALTER TABLE city_memberships
  ADD COLUMN IF NOT EXISTS membership_id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS house_structure_id uuid NULL,
  ADD COLUMN IF NOT EXISTS ended_reason text NULL,
  ADD COLUMN IF NOT EXISTS previous_city_id uuid NULL,
  ADD COLUMN IF NOT EXISTS foreign_city_block_until timestamptz NULL;

UPDATE city_memberships
SET left_at = COALESCE(left_at, now()),
    ended_reason = COALESCE(ended_reason, 'city_house_authority_reset')
WHERE left_at IS NULL;

UPDATE cities
SET mayor_player_id = NULL,
    mayor_house_deadline = NULL,
    mayor_confirmed_at = NULL,
    spatial_revision = spatial_revision + 1
WHERE mayor_player_id IS NOT NULL
   OR mayor_house_deadline IS NOT NULL
   OR mayor_confirmed_at IS NOT NULL;

ALTER TABLE city_memberships
  ALTER COLUMN membership_id SET NOT NULL;

ALTER TABLE city_memberships
  DROP CONSTRAINT IF EXISTS city_memberships_pkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'city_memberships'::regclass
      AND conname = 'city_memberships_pkey'
  ) THEN
    ALTER TABLE city_memberships
      ADD CONSTRAINT city_memberships_pkey PRIMARY KEY (membership_id);
  END IF;
END
$$;

ALTER TABLE city_memberships
  DROP CONSTRAINT IF EXISTS city_memberships_role_valid,
  ADD CONSTRAINT city_memberships_role_valid CHECK (role IN ('founder', 'member', 'mayor')),
  ADD CONSTRAINT city_memberships_ended_reason_valid CHECK (
    ended_reason IS NULL OR ended_reason IN (
      'city_house_authority_reset',
      'house_destroyed',
      'city_deactivated'
    )
  ),
  ADD CONSTRAINT city_memberships_house_lifecycle_valid CHECK (
    (left_at IS NULL AND house_structure_id IS NOT NULL AND ended_reason IS NULL)
    OR left_at IS NOT NULL
  ),
  ADD CONSTRAINT city_memberships_foreign_cooldown_valid CHECK (
    (previous_city_id IS NULL AND foreign_city_block_until IS NULL)
    OR (previous_city_id IS NOT NULL AND foreign_city_block_until IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS city_memberships_one_active_player_city_idx
  ON city_memberships (city_id, player_id)
  WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS city_memberships_history_player_idx
  ON city_memberships (player_id, joined_at DESC, membership_id);
CREATE INDEX IF NOT EXISTS city_memberships_house_idx
  ON city_memberships (house_structure_id)
  WHERE house_structure_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS city_structures (
  structure_id uuid PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  structure_type text NOT NULL CHECK (
    structure_type IN ('city_house', 'mayor_house', 'warehouse', 'weaponsmith', 'armory')
  ),
  tier smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 3),
  owner_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  footprint_geom geometry(Polygon, 4326) NOT NULL,
  footprint_radius_m double precision NOT NULL CHECK (footprint_radius_m > 0),
  placement_revision bigint NOT NULL DEFAULT 1 CHECK (placement_revision > 0),
  state text NOT NULL CHECK (state IN ('constructing', 'active', 'destroyed')),
  build_operation_key text NOT NULL,
  built_at timestamptz NULL,
  upgraded_at timestamptz NULL,
  destroyed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (build_operation_key),
  CHECK (
    (structure_type IN ('city_house', 'mayor_house') AND owner_player_id IS NOT NULL)
    OR (structure_type IN ('warehouse', 'weaponsmith', 'armory') AND owner_player_id IS NULL)
  ),
  CHECK (
    (state = 'constructing' AND built_at IS NULL AND destroyed_at IS NULL)
    OR (state = 'active' AND built_at IS NOT NULL AND destroyed_at IS NULL)
    OR (state = 'destroyed' AND built_at IS NOT NULL AND destroyed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS city_structures_city_active_idx
  ON city_structures (city_id, structure_type, tier)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS city_structures_geom_gix
  ON city_structures USING gist (geom);
CREATE INDEX IF NOT EXISTS city_structures_footprint_gix
  ON city_structures USING gist (footprint_geom);
CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_active_house_per_player_idx
  ON city_structures (owner_player_id)
  WHERE state = 'active' AND structure_type IN ('city_house', 'mayor_house');
CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_active_facility_type_idx
  ON city_structures (city_id, structure_type)
  WHERE state = 'active' AND structure_type IN ('warehouse', 'weaponsmith', 'armory');
CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_active_mayor_house_idx
  ON city_structures (city_id)
  WHERE state = 'active' AND structure_type = 'mayor_house';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'city_memberships'::regclass
      AND conname = 'city_memberships_house_structure_fkey'
  ) THEN
    ALTER TABLE city_memberships
      ADD CONSTRAINT city_memberships_house_structure_fkey
      FOREIGN KEY (house_structure_id) REFERENCES city_structures(structure_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS city_structure_operations (
  operation_key text PRIMARY KEY,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (
    action IN ('build_house', 'destroy_house', 'build_facility', 'upgrade_facility',
               'destroy_facility', 'claim_mayor', 'relinquish_mayor', 'expire_founder_grace')
  ),
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  structure_id uuid NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  intent jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(intent::text) <= 8192),
  result jsonb NULL CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (actor_player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE TABLE IF NOT EXISTS city_structure_events (
  event_id bigserial PRIMARY KEY,
  operation_key text NOT NULL REFERENCES city_structure_operations(operation_key) ON DELETE RESTRICT,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  actor_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (
    event_type IN ('built', 'upgraded', 'destroyed', 'promoted_to_mayor_house',
                   'demoted_to_city_house')
  ),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(details::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_key, event_type)
);

CREATE TABLE IF NOT EXISTS city_treasuries (
  city_id uuid PRIMARY KEY REFERENCES cities(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned bigint NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  lifetime_spent bigint NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lifetime_earned >= balance)
);

INSERT INTO city_treasuries (city_id)
SELECT id FROM cities
ON CONFLICT (city_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS city_coin_ledger (
  entry_id bigserial PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  membership_id uuid NULL REFERENCES city_memberships(membership_id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('combat_contribution', 'construction_spend')),
  delta bigint NOT NULL CHECK (delta <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  source_type text NOT NULL,
  source_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS city_coin_ledger_city_created_idx
  ON city_coin_ledger (city_id, created_at DESC, entry_id);

CREATE TABLE IF NOT EXISTS city_coin_contributions (
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  lifetime_contributed bigint NOT NULL DEFAULT 0 CHECK (lifetime_contributed >= 0),
  first_contributed_at timestamptz NOT NULL DEFAULT now(),
  last_contributed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, player_id)
);
CREATE INDEX IF NOT EXISTS city_coin_contribution_rank_idx
  ON city_coin_contributions (city_id, lifetime_contributed DESC, first_contributed_at, player_id);

CREATE TABLE IF NOT EXISTS city_warehouse_stacks (
  stack_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  slot_index integer NOT NULL CHECK (slot_index >= 0),
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  quantity bigint NOT NULL CHECK (quantity > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, slot_index) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS city_warehouse_stacks_item_idx
  ON city_warehouse_stacks (city_id, item_id, variant, slot_index);

CREATE TABLE IF NOT EXISTS city_warehouse_operations (
  operation_key text PRIMARY KEY,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('donate', 'donate_all', 'move', 'reorganize', 'consume')),
  intent jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(intent::text) <= 8192),
  result jsonb NULL CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (actor_player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE TABLE IF NOT EXISTS city_warehouse_events (
  event_id bigserial PRIMARY KEY,
  operation_key text NOT NULL REFERENCES city_warehouse_operations(operation_key) ON DELETE RESTRICT,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('donated', 'moved', 'consumed')),
  item_id text NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NULL,
  quantity bigint NULL CHECK (quantity IS NULL OR quantity > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(details::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS city_warehouse_events_donor_idx
  ON city_warehouse_events (city_id, actor_player_id, created_at DESC);

ALTER TABLE equipment_upgrade_operations
  ADD COLUMN IF NOT EXISTS facility_structure_id uuid NULL
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT;

ALTER TABLE combat_reward_settlements
  ADD COLUMN IF NOT EXISTS reward_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reward_city_id uuid NULL REFERENCES cities(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reward_membership_id uuid NULL
    REFERENCES city_memberships(membership_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION reject_city_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'city ledger and event history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS city_coin_ledger_immutable ON city_coin_ledger;
CREATE TRIGGER city_coin_ledger_immutable
BEFORE UPDATE OR DELETE ON city_coin_ledger
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();

DROP TRIGGER IF EXISTS city_structure_events_immutable ON city_structure_events;
CREATE TRIGGER city_structure_events_immutable
BEFORE UPDATE OR DELETE ON city_structure_events
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();

DROP TRIGGER IF EXISTS city_warehouse_events_immutable ON city_warehouse_events;
CREATE TRIGGER city_warehouse_events_immutable
BEFORE UPDATE OR DELETE ON city_warehouse_events
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();

COMMENT ON COLUMN city_memberships.ended_reason IS
  'Auditable reason an active house-backed membership ended; city_house_authority_reset marks the one-time legacy reset.';
COMMENT ON COLUMN combat_reward_settlements.reward_membership_id IS
  'House-backed membership captured at defeat acceptance so delayed settlement cannot redirect City Coins.';
COMMENT ON COLUMN combat_reward_settlements.reward_player_id IS
  'Authoritative ordinary-reward recipient captured at defeat acceptance; City Coins use the same recipient.';
