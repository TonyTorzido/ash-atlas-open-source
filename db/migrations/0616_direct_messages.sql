-- Durable one-to-one messaging reuses the canonical chat channel, sequence, and
-- message ledgers. This migration only adds the private-conversation ownership,
-- participant state, reconnect event stream, preferences, and shared rate quota.

CREATE TABLE IF NOT EXISTS direct_conversations (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL UNIQUE REFERENCES chat_channels(id) ON DELETE RESTRICT,
  player_low_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  player_high_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  latest_sequence bigint NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT direct_conversations_canonical_pair CHECK (player_low_id < player_high_id),
  CONSTRAINT direct_conversations_pair_unique UNIQUE (player_low_id, player_high_id),
  CONSTRAINT direct_conversations_id_low_unique UNIQUE (id, player_low_id),
  CONSTRAINT direct_conversations_id_high_unique UNIQUE (id, player_high_id)
);

CREATE INDEX IF NOT EXISTS direct_conversations_recent_idx
  ON direct_conversations (last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS direct_conversations_low_recent_idx
  ON direct_conversations (player_low_id, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS direct_conversations_high_recent_idx
  ON direct_conversations (player_high_id, last_activity_at DESC, id DESC);

DROP TRIGGER IF EXISTS direct_conversations_set_updated_at ON direct_conversations;
CREATE TRIGGER direct_conversations_set_updated_at
BEFORE UPDATE ON direct_conversations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS direct_conversation_participants (
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
  last_delivered_sequence bigint NOT NULL DEFAULT 0 CHECK (last_delivered_sequence >= 0),
  last_read_at timestamptz NULL,
  last_delivered_at timestamptz NULL,
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  muted boolean NOT NULL DEFAULT false,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, player_id),
  CONSTRAINT direct_participant_state_order CHECK (
    last_delivered_sequence >= last_read_sequence
    AND ((last_read_sequence = 0) = (last_read_at IS NULL))
    AND ((last_delivered_sequence = 0) = (last_delivered_at IS NULL))
  )
);

CREATE INDEX IF NOT EXISTS direct_participants_player_recent_idx
  ON direct_conversation_participants (player_id, last_active_at DESC, conversation_id DESC);
CREATE INDEX IF NOT EXISTS direct_participants_player_unread_idx
  ON direct_conversation_participants (player_id, unread_count, last_active_at DESC)
  WHERE unread_count > 0;

DROP TRIGGER IF EXISTS direct_conversation_participants_set_updated_at
  ON direct_conversation_participants;
CREATE TRIGGER direct_conversation_participants_set_updated_at
BEFORE UPDATE ON direct_conversation_participants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A deferred guard makes a conversation commit only with its exact canonical two
-- participant rows while still allowing the service to insert the parent first.
CREATE OR REPLACE FUNCTION validate_direct_conversation_participants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id uuid;
  expected_low text;
  expected_high text;
  actual_players text[];
BEGIN
  IF TG_TABLE_NAME = 'direct_conversations' THEN
    target_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_id := COALESCE(NEW.conversation_id, OLD.conversation_id);
  END IF;

  SELECT player_low_id, player_high_id
    INTO expected_low, expected_high
  FROM direct_conversations
  WHERE id = target_id;

  -- Deleting the parent is permitted; its participant rows cascade away.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(player_id ORDER BY player_id)
    INTO actual_players
  FROM direct_conversation_participants
  WHERE conversation_id = target_id;

  IF actual_players IS DISTINCT FROM ARRAY[expected_low, expected_high]::text[] THEN
    RAISE EXCEPTION 'direct conversation must have its exact canonical participants'
      USING ERRCODE = '23514', CONSTRAINT = 'direct_conversation_exact_participants';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS direct_conversations_participant_guard ON direct_conversations;
CREATE CONSTRAINT TRIGGER direct_conversations_participant_guard
AFTER INSERT OR UPDATE ON direct_conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_direct_conversation_participants();

DROP TRIGGER IF EXISTS direct_participants_membership_guard ON direct_conversation_participants;
CREATE CONSTRAINT TRIGGER direct_participants_membership_guard
AFTER INSERT OR UPDATE OR DELETE ON direct_conversation_participants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_direct_conversation_participants();

CREATE TABLE IF NOT EXISTS direct_message_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  conversation_id uuid NULL REFERENCES direct_conversations(id) ON DELETE RESTRICT,
  message_id uuid NULL REFERENCES chat_messages(id) ON DELETE RESTRICT,
  actor_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  position_sequence bigint NULL CHECK (position_sequence IS NULL OR position_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT direct_message_events_type_valid CHECK (
    event_type IN (
      'conversation_opened', 'message', 'delivered', 'read',
      'conversation_muted', 'preferences_updated'
    )
  ),
  CONSTRAINT direct_message_events_shape_valid CHECK (
    (event_type = 'preferences_updated'
      AND conversation_id IS NULL AND message_id IS NULL AND position_sequence IS NULL)
    OR (event_type = 'message'
      AND conversation_id IS NOT NULL AND message_id IS NOT NULL AND position_sequence > 0)
    OR (event_type IN ('delivered', 'read')
      AND conversation_id IS NOT NULL AND message_id IS NULL AND position_sequence > 0)
    OR (event_type IN ('conversation_opened', 'conversation_muted')
      AND conversation_id IS NOT NULL AND message_id IS NULL AND position_sequence IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS direct_message_events_player_cursor_idx
  ON direct_message_events (player_id, event_id);
CREATE INDEX IF NOT EXISTS direct_message_events_conversation_idx
  ON direct_message_events (conversation_id, event_id DESC)
  WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS direct_message_event_cursors (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  last_ack_event_id bigint NOT NULL DEFAULT 0 CHECK (last_ack_event_id >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS direct_message_event_cursors_set_updated_at
  ON direct_message_event_cursors;
CREATE TRIGGER direct_message_event_cursors_set_updated_at
BEFORE UPDATE ON direct_message_event_cursors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS player_direct_message_preferences (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  sounds_enabled boolean NOT NULL DEFAULT true,
  suppress_banners_in_combat boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS player_direct_message_preferences_set_updated_at
  ON player_direct_message_preferences;
CREATE TRIGGER player_direct_message_preferences_set_updated_at
BEFORE UPDATE ON player_direct_message_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS direct_message_rate_windows (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (player_id, window_started_at)
);

CREATE INDEX IF NOT EXISTS direct_message_rate_windows_cleanup_idx
  ON direct_message_rate_windows (window_started_at);
