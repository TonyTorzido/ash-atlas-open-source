CREATE TABLE IF NOT EXISTS harvest_sessions (
  id uuid PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  node_id text NOT NULL REFERENCES collectible_nodes(id) ON DELETE RESTRICT,
  resource_type text NOT NULL REFERENCES item_definitions(item_id),
  operation_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completes_at > started_at),
  CHECK (expires_at > completes_at),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS harvest_sessions_one_active_per_player_idx
  ON harvest_sessions (player_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS harvest_sessions_one_active_per_node_idx
  ON harvest_sessions (node_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS harvest_sessions_player_created_idx
  ON harvest_sessions (player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS harvest_sessions_node_created_idx
  ON harvest_sessions (node_id, created_at DESC);

CREATE INDEX IF NOT EXISTS harvest_sessions_operation_key_idx
  ON harvest_sessions (operation_key);

CREATE INDEX IF NOT EXISTS harvest_sessions_status_expiry_idx
  ON harvest_sessions (status, expires_at);

DROP TRIGGER IF EXISTS harvest_sessions_set_updated_at ON harvest_sessions;
CREATE TRIGGER harvest_sessions_set_updated_at
BEFORE UPDATE ON harvest_sessions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
