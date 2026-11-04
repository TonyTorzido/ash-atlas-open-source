-- Normalize legacy directional enemy marks into one canonical relationship row.
INSERT INTO player_enemy_marks (owner_id, target_id, created_at)
SELECT LEAST(owner_id, target_id), GREATEST(owner_id, target_id), MIN(created_at)
FROM player_enemy_marks
GROUP BY LEAST(owner_id, target_id), GREATEST(owner_id, target_id)
ON CONFLICT (owner_id, target_id) DO UPDATE
SET created_at = LEAST(player_enemy_marks.created_at, EXCLUDED.created_at);

DELETE FROM player_enemy_marks WHERE owner_id > target_id;

ALTER TABLE player_enemy_marks
  DROP CONSTRAINT IF EXISTS player_enemy_marks_no_self;
ALTER TABLE player_enemy_marks
  DROP CONSTRAINT IF EXISTS player_enemy_marks_canonical_pair;
ALTER TABLE player_enemy_marks
  ADD CONSTRAINT player_enemy_marks_canonical_pair CHECK (owner_id < target_id);

CREATE TABLE IF NOT EXISTS enemy_neutrality_requests (
  player_low_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_high_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  requester_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (player_low_id, player_high_id),
  CONSTRAINT enemy_neutrality_requests_canonical_pair
    CHECK (player_low_id < player_high_id),
  CONSTRAINT enemy_neutrality_requests_requester_in_pair
    CHECK (requester_id = player_low_id OR requester_id = player_high_id)
);

CREATE INDEX IF NOT EXISTS enemy_neutrality_requests_requester_created_idx
  ON enemy_neutrality_requests (requester_id, created_at DESC, player_low_id, player_high_id);
CREATE INDEX IF NOT EXISTS enemy_neutrality_requests_expiry_idx
  ON enemy_neutrality_requests (expires_at);

DROP TRIGGER IF EXISTS enemy_neutrality_requests_set_updated_at ON enemy_neutrality_requests;
CREATE TRIGGER enemy_neutrality_requests_set_updated_at
BEFORE UPDATE ON enemy_neutrality_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
