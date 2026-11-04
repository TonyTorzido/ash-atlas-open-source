-- Wandering Merchant, Lamp Sheath and Cinder Lantern.
-- A merchant appears outside a dungeon entrance for the player who completed it and stays 30 minutes;
-- only that player can see it or buy from it. Lanterns replace a dungeon's entry cost with one of
-- 9 charges and triple monster drops while the run lasts. Forward-only and idempotent.
INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants, unit_weight_grams
)
VALUES
  ('lamp_sheath', 'Lamp Sheath', 'resource', 'rare', true, 10, true, true, true, true, 'lamp_sheath', ARRAY['default']::text[], 10),
  ('cinder_lantern', 'Cinder Lantern', 'resource', 'rare', true, 1, false, true, false, false, NULL, ARRAY['default']::text[], 10)
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

CREATE TABLE IF NOT EXISTS wandering_merchants (
  merchant_id text PRIMARY KEY,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  spawn_key text NOT NULL,
  dungeon_id text NOT NULL,
  entrance_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lon double precision NOT NULL CHECK (lon >= -180 AND lon <= 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (owner_player_id, spawn_key)
);
CREATE INDEX IF NOT EXISTS wandering_merchants_owner_expiry_idx
  ON wandering_merchants (owner_player_id, expires_at);

-- One row per good. base_price_gold is NULL for Lamp Sheaths, which cost character level x 1,000.
CREATE TABLE IF NOT EXISTS wandering_merchant_stock (
  merchant_id text NOT NULL REFERENCES wandering_merchants(merchant_id) ON DELETE CASCADE,
  item_id text NOT NULL,
  base_price_gold bigint NULL CHECK (base_price_gold IS NULL OR base_price_gold > 0),
  remaining integer NOT NULL CHECK (remaining >= 0),
  PRIMARY KEY (merchant_id, item_id)
);

-- A player's Cinder Lantern charges; the row exists while the item does.
CREATE TABLE IF NOT EXISTS cinder_lanterns (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  charges integer NOT NULL CHECK (charges >= 0 AND charges <= 12),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dungeon runs the player entered on a lantern charge; monster drops are tripled for them.
CREATE TABLE IF NOT EXISTS cinder_lantern_runs (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, run_id)
);
