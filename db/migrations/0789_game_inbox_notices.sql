ALTER TABLE player_inbox_entries
  ADD COLUMN IF NOT EXISTS event_kind text NULL,
  ADD COLUMN IF NOT EXISTS event_id uuid NULL;

ALTER TABLE player_inbox_entries
  DROP CONSTRAINT IF EXISTS player_inbox_entries_source_check;
ALTER TABLE player_inbox_entries
  ADD CONSTRAINT player_inbox_entries_source_check CHECK (
    (entry_kind = 'travel_invite'
      AND travel_invite_id IS NOT NULL
      AND perspective IS NOT NULL
      AND actor_player_id IS NULL
      AND friend_request_id IS NULL
      AND enemy_declaration_id IS NULL
      AND event_kind IS NULL
      AND event_id IS NULL)
    OR
    (entry_kind = 'friend_request'
      AND travel_invite_id IS NULL
      AND perspective IS NULL
      AND actor_player_id IS NOT NULL
      AND friend_request_id IS NOT NULL
      AND enemy_declaration_id IS NULL
      AND event_kind IS NULL
      AND event_id IS NULL
      AND status IN ('pending', 'accepted', 'declined', 'cancelled'))
    OR
    (entry_kind = 'enemy_declaration'
      AND travel_invite_id IS NULL
      AND perspective IS NULL
      AND actor_player_id IS NOT NULL
      AND friend_request_id IS NULL
      AND enemy_declaration_id IS NOT NULL
      AND event_kind IS NULL
      AND event_id IS NULL
      AND status = 'notice')
    OR
    (entry_kind = 'game_notice'
      AND travel_invite_id IS NULL
      AND perspective IS NULL
      AND actor_player_id IS NULL
      AND friend_request_id IS NULL
      AND enemy_declaration_id IS NULL
      AND event_kind IS NOT NULL
      AND event_id IS NOT NULL
      AND status = 'notice')
  );

CREATE UNIQUE INDEX IF NOT EXISTS player_inbox_entries_game_notice_unique
  ON player_inbox_entries (player_id, event_kind, event_id)
  WHERE entry_kind = 'game_notice';

CREATE INDEX IF NOT EXISTS player_inbox_entries_game_notice_player_created_idx
  ON player_inbox_entries (player_id, created_at DESC, id DESC)
  WHERE entry_kind = 'game_notice';

COMMENT ON TABLE player_inbox_entries IS
  'Authoritative durable Messages projections linked to travel, social relationships, and game events.';
