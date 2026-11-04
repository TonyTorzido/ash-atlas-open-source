CREATE TABLE IF NOT EXISTS world_item_pickups (
  operation_key text PRIMARY KEY
    REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  drop_id uuid NOT NULL REFERENCES world_item_drops(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  pickup_mode text NOT NULL CHECK (pickup_mode IN ('all', 'quantity')),
  requested_quantity integer NULL CHECK (requested_quantity IS NULL OR requested_quantity > 0),
  granted_quantity integer NOT NULL CHECK (granted_quantity > 0),
  remaining_quantity integer NOT NULL CHECK (remaining_quantity >= 0),
  resulting_status text NOT NULL CHECK (resulting_status IN ('active', 'picked_up')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (pickup_mode = 'all' AND requested_quantity IS NULL)
    OR
    (pickup_mode = 'quantity' AND requested_quantity IS NOT NULL)
  ),
  CHECK (
    (remaining_quantity = 0 AND resulting_status = 'picked_up')
    OR
    (remaining_quantity > 0 AND resulting_status = 'active')
  )
);

CREATE INDEX IF NOT EXISTS world_item_pickups_drop_created_idx
  ON world_item_pickups (drop_id, created_at);

CREATE INDEX IF NOT EXISTS world_item_pickups_player_created_idx
  ON world_item_pickups (player_id, created_at DESC);
