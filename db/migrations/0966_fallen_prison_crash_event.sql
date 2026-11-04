-- Fallen Prison crash event: world placements that expire on their own (20 h) and keep the
-- dungeon's normal entry rules, plus the per-player trail claim record.
ALTER TABLE developer_spawned_dungeon_entrances
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS event_kind TEXT NULL;

CREATE TABLE IF NOT EXISTS fallen_prison_trail_claims (
  player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  entrance_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
