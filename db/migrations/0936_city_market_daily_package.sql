-- City Market "Daily offer": once per UTC day a city member buys one
-- package of City Coins (110/215/320 by Market tier) for Glimmer (4/7/9). The
-- Glimmer is debited through premium_wallet_events and the coins credited
-- through city_coin_ledger; this table is the once-per-day gate and the
-- request-level replay record (PRIMARY KEY (player_id, purchase_day)).
CREATE TABLE IF NOT EXISTS city_market_daily_purchases (
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  purchase_day date NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  operation_key text NOT NULL UNIQUE,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  market_structure_id uuid NOT NULL,
  tier smallint NOT NULL CHECK (tier BETWEEN 1 AND 3),
  city_coins integer NOT NULL CHECK (city_coins > 0),
  glimmer_cost integer NOT NULL CHECK (glimmer_cost > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (player_id, purchase_day),
  UNIQUE (player_id, request_id)
);
CREATE INDEX IF NOT EXISTS city_market_daily_purchases_city_idx
  ON city_market_daily_purchases (city_id, purchase_day DESC);

DROP TRIGGER IF EXISTS city_market_daily_purchases_immutable ON city_market_daily_purchases;
CREATE TRIGGER city_market_daily_purchases_immutable
BEFORE UPDATE OR DELETE ON city_market_daily_purchases
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();

-- Every entry type any earlier migration allowed stays allowed (see 0919).
ALTER TABLE city_coin_ledger
  DROP CONSTRAINT IF EXISTS city_coin_ledger_entry_type_check;
ALTER TABLE city_coin_ledger
  ADD CONSTRAINT city_coin_ledger_entry_type_check
  CHECK (entry_type IN (
    'combat_contribution',
    'development_grant',
    'package_grant',
    'construction_spend',
    'construction_refund',
    'structure_repair',
    'war_surrender_transfer',
    'war_surrender_destroyed',
    'market_daily_package'
  ));
