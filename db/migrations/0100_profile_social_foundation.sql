CREATE TABLE IF NOT EXISTS player_profiles (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  title text NULL CHECK (title IS NULL OR char_length(title) <= 32),
  biography text NULL CHECK (biography IS NULL OR char_length(biography) <= 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO player_profiles (player_id)
SELECT id FROM players
ON CONFLICT (player_id) DO NOTHING;

DROP TRIGGER IF EXISTS player_profiles_set_updated_at ON player_profiles;
CREATE TRIGGER player_profiles_set_updated_at
BEFORE UPDATE ON player_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS friend_requests (
  requester_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, recipient_id),
  CONSTRAINT friend_requests_no_self CHECK (requester_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS friend_requests_recipient_created_idx
  ON friend_requests (recipient_id, created_at DESC, requester_id);
CREATE INDEX IF NOT EXISTS friend_requests_requester_created_idx
  ON friend_requests (requester_id, created_at DESC, recipient_id);

DROP TRIGGER IF EXISTS friend_requests_set_updated_at ON friend_requests;
CREATE TRIGGER friend_requests_set_updated_at
BEFORE UPDATE ON friend_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS friendships (
  player_low_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_high_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_low_id, player_high_id),
  CONSTRAINT friendships_canonical_pair CHECK (player_low_id < player_high_id)
);

CREATE INDEX IF NOT EXISTS friendships_low_created_idx
  ON friendships (player_low_id, created_at DESC, player_high_id);
CREATE INDEX IF NOT EXISTS friendships_high_created_idx
  ON friendships (player_high_id, created_at DESC, player_low_id);

CREATE TABLE IF NOT EXISTS player_enemy_marks (
  owner_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, target_id),
  CONSTRAINT player_enemy_marks_no_self CHECK (owner_id <> target_id)
);

CREATE INDEX IF NOT EXISTS player_enemy_marks_owner_created_idx
  ON player_enemy_marks (owner_id, created_at DESC, target_id);
CREATE INDEX IF NOT EXISTS player_enemy_marks_target_idx
  ON player_enemy_marks (target_id, owner_id);

CREATE TABLE IF NOT EXISTS player_blocks (
  blocker_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  blocked_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT player_blocks_no_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS player_blocks_blocker_created_idx
  ON player_blocks (blocker_id, created_at DESC, blocked_id);
CREATE INDEX IF NOT EXISTS player_blocks_blocked_idx
  ON player_blocks (blocked_id, blocker_id);
