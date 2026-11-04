-- Hollin Huts placed by the world itself have no creator (creator_player_id IS NULL). The existing
-- UNIQUE (creator_player_id, request_id) never matches NULL creators, so give them their own
-- idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS hollin_huts_world_request_uniq
  ON hollin_huts (request_id)
  WHERE creator_player_id IS NULL;
