-- Idempotent Hunger debits for deliberate long-distance overworld travel.
-- The operation ledger is written in the same transaction as the player's
-- relocation so retries cannot debit twice or turn a failed travel into a
-- consumed resource.
CREATE TABLE travel_hunger_consumption_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  destination_identity text NOT NULL,
  distance_m double precision NOT NULL CHECK (distance_m >= 0),
  max_range_m double precision NOT NULL CHECK (max_range_m > 0),
  cost integer NOT NULL CHECK (cost BETWEEN 1 AND 100),
  hunger_before integer NOT NULL CHECK (hunger_before >= 0),
  hunger_after integer NOT NULL CHECK (hunger_after >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id, request_id)
);
CREATE INDEX travel_hunger_consumption_operations_player_idx
  ON travel_hunger_consumption_operations(player_id, created_at DESC);
