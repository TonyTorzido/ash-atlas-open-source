ALTER TABLE friend_requests
  ADD COLUMN IF NOT EXISTS id uuid;
UPDATE friend_requests
SET id = gen_random_uuid()
WHERE id IS NULL;
ALTER TABLE friend_requests
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_id_unique
  ON friend_requests (id);

ALTER TABLE player_enemy_marks
  ADD COLUMN IF NOT EXISTS id uuid;
UPDATE player_enemy_marks
SET id = gen_random_uuid()
WHERE id IS NULL;
ALTER TABLE player_enemy_marks
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_enemy_marks_id_unique
  ON player_enemy_marks (id);

ALTER TABLE player_inbox_entries
  ALTER COLUMN travel_invite_id DROP NOT NULL,
  ALTER COLUMN perspective DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS entry_kind text NOT NULL DEFAULT 'travel_invite',
  ADD COLUMN IF NOT EXISTS actor_player_id text NULL REFERENCES players(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS friend_request_id uuid NULL,
  ADD COLUMN IF NOT EXISTS enemy_declaration_id uuid NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'notice',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE player_inbox_entries
  DROP CONSTRAINT IF EXISTS player_inbox_entries_source_check;
ALTER TABLE player_inbox_entries
  ADD CONSTRAINT player_inbox_entries_source_check CHECK (
    (entry_kind = 'travel_invite'
      AND travel_invite_id IS NOT NULL
      AND perspective IS NOT NULL
      AND actor_player_id IS NULL
      AND friend_request_id IS NULL
      AND enemy_declaration_id IS NULL)
    OR
    (entry_kind = 'friend_request'
      AND travel_invite_id IS NULL
      AND perspective IS NULL
      AND actor_player_id IS NOT NULL
      AND friend_request_id IS NOT NULL
      AND enemy_declaration_id IS NULL
      AND status IN ('pending', 'accepted', 'declined', 'cancelled'))
    OR
    (entry_kind = 'enemy_declaration'
      AND travel_invite_id IS NULL
      AND perspective IS NULL
      AND actor_player_id IS NOT NULL
      AND friend_request_id IS NULL
      AND enemy_declaration_id IS NOT NULL
      AND status = 'notice')
  );

CREATE UNIQUE INDEX IF NOT EXISTS player_inbox_entries_friend_request_unique
  ON player_inbox_entries (friend_request_id)
  WHERE friend_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_inbox_entries_enemy_declaration_unique
  ON player_inbox_entries (enemy_declaration_id)
  WHERE enemy_declaration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_inbox_entries_social_player_created_idx
  ON player_inbox_entries (player_id, created_at DESC, id DESC)
  WHERE entry_kind IN ('friend_request', 'enemy_declaration');

DROP TRIGGER IF EXISTS player_inbox_entries_set_updated_at ON player_inbox_entries;
CREATE TRIGGER player_inbox_entries_set_updated_at
BEFORE UPDATE ON player_inbox_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE player_inbox_entries IS
  'Authoritative durable Messages projections linked to travel and social relationship events.';
