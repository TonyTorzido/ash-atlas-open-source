-- War monoliths (Field Engineering), part C1. Mirrors
-- packages/shared/src/monoliths.ts.
--
-- A monolith stands at its owner's position: 20 h of life, then 30 h of
-- inert remnants (remnant_until). A recharge restarts both windows. An
-- enemy ignition (25 crude oil) sets burn_until = ignition + 80 min; when the
-- fire ends the monolith is gone. Phases are derived from the timestamps,
-- so effects never wait on a sweep; status only retires rows for the
-- one-standing-monolith-per-type rule and history.
--
-- Allies are resolved live from the owner's current city / kingdom
-- membership, so no allegiance is copied onto the row.

CREATE TABLE IF NOT EXISTS war_monoliths (
  monolith_id uuid PRIMARY KEY,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  monolith_type text NOT NULL CHECK (
    monolith_type IN ('healer', 'reflection', 'gloom', 'berserker', 'hunter', 'fortified')
  ),
  owner_rank smallint NOT NULL CHECK (owner_rank BETWEEN 1 AND 3),
  geom geometry(Point, 4326) NOT NULL,
  placed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  remnant_until timestamptz NOT NULL,
  recharge_count integer NOT NULL DEFAULT 0 CHECK (recharge_count >= 0),
  ignited_by_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  burn_until timestamptz NULL,
  status text NOT NULL DEFAULT 'standing' CHECK (status IN ('standing', 'retired')),
  retired_at timestamptz NULL,
  retired_reason text NULL CHECK (retired_reason IS NULL OR retired_reason IN ('expired', 'burnt', 'replaced')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT war_monoliths_windows_valid CHECK (
    expires_at > placed_at AND remnant_until > expires_at
  ),
  CONSTRAINT war_monoliths_burn_valid CHECK (
    (burn_until IS NULL) = (ignited_by_player_id IS NULL)
  ),
  CONSTRAINT war_monoliths_retired_valid CHECK (
    (status = 'retired') = (retired_at IS NOT NULL)
    AND (status = 'retired') = (retired_reason IS NOT NULL)
  )
);

-- One standing monolith of each type per player.
CREATE UNIQUE INDEX IF NOT EXISTS war_monoliths_one_standing_type_idx
  ON war_monoliths (owner_player_id, monolith_type)
  WHERE status = 'standing';

-- Range probes (siege, bomber, brick / City Coin yield, nearby list).
CREATE INDEX IF NOT EXISTS war_monoliths_standing_geography_gix
  ON war_monoliths USING gist ((geom::geography))
  WHERE status = 'standing';

-- Every place / recharge / ignite / discovery, one row per (player,
-- request). A replayed request returns the recorded result and never
-- charges twice; the inventory debit shares the operation key.
CREATE TABLE IF NOT EXISTS war_monolith_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('place', 'recharge', 'ignite')),
  monolith_id uuid NOT NULL,
  monolith_type text NOT NULL,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  item_quantity integer NOT NULL CHECK (item_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT war_monolith_operations_request_unique UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS war_monolith_operations_monolith_idx
  ON war_monolith_operations (monolith_id, created_at DESC);

DROP TRIGGER IF EXISTS war_monolith_operations_append_only ON war_monolith_operations;
CREATE TRIGGER war_monolith_operations_append_only
BEFORE UPDATE OR DELETE ON war_monolith_operations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

COMMENT ON TABLE war_monoliths IS
  'Field Engineering monoliths: 20 h life, 30 h remnants, 80 min burn after an enemy ignition. Phases derive from the timestamps.';
COMMENT ON TABLE war_monolith_operations IS
  'Append-only, idempotent monolith place / recharge / ignite operations keyed by (player, request).';
