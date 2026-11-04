-- Support actor-scoped lazy replay retention without scanning every actor's old rows.
CREATE INDEX IF NOT EXISTS kingdom_requests_actor_created_idx
  ON kingdom_requests (actor_player_id, created_at);
