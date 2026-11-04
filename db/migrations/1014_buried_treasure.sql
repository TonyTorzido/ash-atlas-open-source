-- Buried treasure and digging (Cartography treasure). Mirrors
-- packages/shared/src/buriedTreasure.ts.
--
-- Caches of three tiers (bronze, silver, gold) are buried on land near players with
-- a lifetime. A cache is dug once: the dig locks the row, flips it to 'dug' and
-- records the digger and the operation in the same transaction, so two simultaneous
-- diggers produce exactly one winner. A unique index on the operation ledger is the
-- second backstop (one 'dig' operation per treasure). Rewards are granted through the
-- inventory ledger under the key buried-treasure:<treasure_id>, so a replay never
-- pays twice.
--
-- The Shovel is a carried consumable. It wears out per dig: player_shovel_wear counts
-- the digs on the shovel in use; at the last dig one Shovel is debited and the count
-- resets.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('shovel', 'Shovel', 'consumable', 'common', true, 25, true, true, false, false, NULL, ARRAY['default']::text[], 2000)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  unit_weight_grams = EXCLUDED.unit_weight_grams,
  updated_at = now();

CREATE TABLE IF NOT EXISTS buried_treasures (
  treasure_id uuid PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
  geom geometry(Point, 4326) NOT NULL,
  place_label text NULL CHECK (place_label IS NULL OR length(place_label) BETWEEN 1 AND 160),
  landmark_kind text NULL CHECK (
    landmark_kind IS NULL OR landmark_kind IN ('city', 'atlas_shrine', 'hollin_hut', 'kingdom_seat')
  ),
  spawned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'buried' CHECK (status IN ('buried', 'dug', 'expired')),
  dug_by_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  dug_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT buried_treasures_window_valid CHECK (expires_at > spawned_at),
  CONSTRAINT buried_treasures_dug_valid CHECK (
    (status = 'dug') = (dug_by_player_id IS NOT NULL AND dug_at IS NOT NULL)
  )
);

-- Nearby list, density counts and spacing probes.
CREATE INDEX IF NOT EXISTS buried_treasures_buried_geography_gix
  ON buried_treasures USING gist ((geom::geography))
  WHERE status = 'buried';

-- Expiry sweep and the global cap count.
CREATE INDEX IF NOT EXISTS buried_treasures_status_expiry_idx
  ON buried_treasures (status, expires_at);

-- Every dig and shovel craft, one row per (player, request). A replayed request
-- returns the recorded result and never charges or pays twice.
CREATE TABLE IF NOT EXISTS buried_treasure_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('dig', 'artisan_shovel')),
  treasure_id uuid NULL,
  tier text NULL CHECK (tier IS NULL OR tier IN ('bronze', 'silver', 'gold')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT buried_treasure_operations_request_unique UNIQUE (player_id, request_id),
  CONSTRAINT buried_treasure_operations_dig_has_treasure CHECK (
    (action = 'dig') = (treasure_id IS NOT NULL)
  )
);

-- A cache pays out at most once, whatever the application does.
CREATE UNIQUE INDEX IF NOT EXISTS buried_treasure_operations_one_dig_idx
  ON buried_treasure_operations (treasure_id)
  WHERE action = 'dig';

DROP TRIGGER IF EXISTS buried_treasure_operations_append_only ON buried_treasure_operations;
CREATE TRIGGER buried_treasure_operations_append_only
BEFORE UPDATE OR DELETE ON buried_treasure_operations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

-- Digs used on the shovel currently in use (0 = a fresh shovel).
CREATE TABLE IF NOT EXISTS player_shovel_wear (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  uses_on_current smallint NOT NULL DEFAULT 0 CHECK (uses_on_current BETWEEN 0 AND 99),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE buried_treasures IS
  'Buried treasure caches (bronze, silver, gold): dug once, first digger wins, expire after a tier lifetime.';
COMMENT ON TABLE buried_treasure_operations IS
  'Append-only, idempotent dig and shovel-craft operations keyed by (player, request); one dig per treasure.';
COMMENT ON TABLE player_shovel_wear IS
  'Digs used on the Shovel currently in use; a Shovel is debited on its last dig.';
