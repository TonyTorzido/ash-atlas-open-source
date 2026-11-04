-- Goblin Market wheat seeds are a light, fixed-price NPC stock item.
-- Keep the catalog and carried-weight authority aligned for existing rows.
UPDATE item_definitions
SET unit_weight_grams = 1,
    updated_at = now()
WHERE item_id = 'wheat_seed';

CREATE TABLE goblin_market_stock (
  market_structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE CASCADE,
  item_id text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_structure_id, item_id)
);

CREATE TABLE goblin_market_purchases (
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  account_id text NOT NULL,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  market_structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  item_id text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  unit_price_gold bigint NOT NULL CHECK (unit_price_gold > 0),
  total_gold bigint NOT NULL CHECK (total_gold > 0),
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  PRIMARY KEY (player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);
CREATE INDEX goblin_market_purchases_market_idx
  ON goblin_market_purchases(market_structure_id, created_at DESC);
