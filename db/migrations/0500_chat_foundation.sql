CREATE TABLE IF NOT EXISTS chat_channels (
  id uuid PRIMARY KEY,
  channel_key text NOT NULL UNIQUE,
  channel_type text NOT NULL,
  display_name text NOT NULL,
  visibility_policy text NOT NULL,
  send_access_policy text NOT NULL,
  history_retention_policy text NOT NULL,
  rate_limit_policy text NOT NULL,
  moderation_policy text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_channels_key_valid CHECK (
    char_length(channel_key) BETWEEN 3 AND 128
    AND channel_key ~ '^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9:_-]*$'
  ),
  CONSTRAINT chat_channels_type_valid CHECK (
    channel_type IN ('public', 'kingdom', 'party', 'alliance', 'direct')
  ),
  CONSTRAINT chat_channels_display_name_valid CHECK (
    char_length(btrim(display_name)) BETWEEN 1 AND 64
  ),
  CONSTRAINT chat_channels_policy_keys_valid CHECK (
    char_length(btrim(visibility_policy)) BETWEEN 1 AND 64
    AND char_length(btrim(send_access_policy)) BETWEEN 1 AND 64
    AND char_length(btrim(history_retention_policy)) BETWEEN 1 AND 64
    AND char_length(btrim(rate_limit_policy)) BETWEEN 1 AND 64
    AND char_length(btrim(moderation_policy)) BETWEEN 1 AND 64
  )
);

DROP TRIGGER IF EXISTS chat_channels_set_updated_at ON chat_channels;
CREATE TRIGGER chat_channels_set_updated_at
BEFORE UPDATE ON chat_channels
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Stable UUIDs make the initial public channels deterministic across databases.
INSERT INTO chat_channels (
  id, channel_key, channel_type, display_name, visibility_policy,
  send_access_policy, history_retention_policy, rate_limit_policy,
  moderation_policy, active
) VALUES
  (
    '05000000-0000-4000-8000-000000000001', 'public:general', 'public', 'General',
    'authenticated_public_v1', 'authenticated_public_v1', 'bounded_public_v1',
    'public_standard_v1', 'public_chat_v1', true
  ),
  (
    '05000000-0000-4000-8000-000000000002', 'public:trading', 'public', 'Trading',
    'authenticated_public_v1', 'authenticated_public_v1', 'bounded_public_v1',
    'public_trading_v1', 'public_chat_v1', true
  ),
  (
    '05000000-0000-4000-8000-000000000003', 'public:hunting', 'public', 'Hunting',
    'authenticated_public_v1', 'authenticated_public_v1', 'bounded_public_v1',
    'public_standard_v1', 'public_chat_v1', true
  )
ON CONFLICT (channel_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS chat_channel_sequences (
  channel_id uuid PRIMARY KEY REFERENCES chat_channels(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS chat_channel_sequences_set_updated_at ON chat_channel_sequences;
CREATE TRIGGER chat_channel_sequences_set_updated_at
BEFORE UPDATE ON chat_channel_sequences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO chat_channel_sequences (channel_id, last_sequence)
SELECT id, 0
FROM chat_channels
WHERE channel_key IN ('public:general', 'public:trading', 'public:hunting')
ON CONFLICT (channel_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE RESTRICT,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  sender_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  sender_display_name text NOT NULL,
  body text NOT NULL,
  client_request_id uuid NOT NULL,
  message_status text NOT NULL DEFAULT 'visible',
  moderation_status text NOT NULL DEFAULT 'pending',
  edited_at timestamptz NULL,
  deleted_at timestamptz NULL,
  deletion_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_sender_name_valid CHECK (
    char_length(btrim(sender_display_name)) BETWEEN 1 AND 64
  ),
  CONSTRAINT chat_messages_body_valid CHECK (
    char_length(body) BETWEEN 1 AND 400
    AND body ~ '[^[:space:]]'
    AND position(chr(13) in body) = 0
  ),
  CONSTRAINT chat_messages_status_valid CHECK (
    message_status IN ('visible', 'hidden', 'deleted')
  ),
  CONSTRAINT chat_messages_moderation_status_valid CHECK (
    moderation_status IN ('pending', 'clear', 'flagged', 'actioned', 'failed')
  ),
  CONSTRAINT chat_messages_edit_timestamp_valid CHECK (
    edited_at IS NULL OR edited_at >= created_at
  ),
  CONSTRAINT chat_messages_delete_state_valid CHECK (
    (message_status = 'deleted' AND deleted_at IS NOT NULL)
    OR (message_status <> 'deleted' AND deleted_at IS NULL)
  ),
  CONSTRAINT chat_messages_delete_metadata_valid CHECK (
    (deleted_at IS NULL AND deletion_reason IS NULL)
    OR (
      deleted_at >= created_at
      AND deletion_reason IS NOT NULL
      AND char_length(btrim(deletion_reason)) BETWEEN 1 AND 240
    )
  )
);

-- This unique descending index is both the ordering guard and the history cursor index.
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_channel_sequence_unique_idx
  ON chat_messages (channel_id, sequence_number DESC);
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_sender_request_unique_idx
  ON chat_messages (sender_player_id, client_request_id);
CREATE INDEX IF NOT EXISTS chat_messages_moderation_status_idx
  ON chat_messages (moderation_status, created_at DESC)
  WHERE moderation_status <> 'clear';

DROP TRIGGER IF EXISTS chat_messages_set_updated_at ON chat_messages;
CREATE TRIGGER chat_messages_set_updated_at
BEFORE UPDATE ON chat_messages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS chat_channel_read_states (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, channel_id)
);

CREATE INDEX IF NOT EXISTS chat_channel_read_states_channel_idx
  ON chat_channel_read_states (channel_id, player_id);

DROP TRIGGER IF EXISTS chat_channel_read_states_set_updated_at ON chat_channel_read_states;
CREATE TRIGGER chat_channel_read_states_set_updated_at
BEFORE UPDATE ON chat_channel_read_states
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS chat_moderation_decisions (
  decision_id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source text NOT NULL,
  policy_version text NOT NULL,
  model_version text NULL,
  rules_version text NULL,
  categories text[] NOT NULL DEFAULT '{}'::text[],
  confidence numeric(5, 4) NOT NULL,
  recommended_action text NOT NULL,
  applied_action text NOT NULL DEFAULT 'no_action',
  requested_mute_scope text NULL,
  requested_duration_seconds integer NULL,
  applied_mute_duration_seconds integer NULL,
  reason text NOT NULL,
  processing_status text NOT NULL DEFAULT 'received',
  error_code text NULL,
  error_summary text NULL,
  reversed_at timestamptz NULL,
  reversed_by text NULL,
  reversal_reason text NULL,
  human_review_status text NOT NULL DEFAULT 'not_required',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_moderation_decisions_source_valid CHECK (
    source IN ('system', 'automated_moderation', 'human_moderator')
  ),
  CONSTRAINT chat_moderation_decisions_versions_valid CHECK (
    char_length(btrim(policy_version)) BETWEEN 1 AND 64
    AND (model_version IS NULL OR char_length(btrim(model_version)) BETWEEN 1 AND 128)
    AND (rules_version IS NULL OR char_length(btrim(rules_version)) BETWEEN 1 AND 128)
  ),
  CONSTRAINT chat_moderation_decisions_categories_valid CHECK (
    cardinality(categories) BETWEEN 0 AND 16
    AND pg_column_size(categories) <= 4096
  ),
  CONSTRAINT chat_moderation_decisions_confidence_valid CHECK (
    confidence BETWEEN 0 AND 1
  ),
  CONSTRAINT chat_moderation_decisions_recommended_action_valid CHECK (
    recommended_action IN (
      'no_action', 'flag_for_review', 'hide_message',
      'temporary_channel_mute', 'temporary_global_mute'
    )
  ),
  CONSTRAINT chat_moderation_decisions_applied_action_valid CHECK (
    applied_action IN (
      'no_action', 'flag_for_review', 'hide_message',
      'temporary_channel_mute', 'temporary_global_mute'
    )
  ),
  CONSTRAINT chat_moderation_decisions_processing_status_valid CHECK (
    processing_status IN ('received', 'applied', 'rejected', 'failed', 'reversed')
  ),
  CONSTRAINT chat_moderation_decisions_human_review_status_valid CHECK (
    human_review_status IN ('not_required', 'pending', 'approved', 'rejected')
  ),
  CONSTRAINT chat_moderation_decisions_reason_valid CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 500
  ),
  CONSTRAINT chat_moderation_decisions_requested_mute_valid CHECK (
    (
      recommended_action = 'temporary_channel_mute'
      AND requested_mute_scope = 'channel'
      AND requested_duration_seconds IS NOT NULL
      AND requested_duration_seconds > 0
    ) OR (
      recommended_action = 'temporary_global_mute'
      AND requested_mute_scope = 'global'
      AND requested_duration_seconds IS NOT NULL
      AND requested_duration_seconds > 0
    ) OR (
      recommended_action NOT IN ('temporary_channel_mute', 'temporary_global_mute')
      AND requested_mute_scope IS NULL
      AND requested_duration_seconds IS NULL
    )
  ),
  CONSTRAINT chat_moderation_decisions_applied_mute_valid CHECK (
    (
      applied_action IN ('temporary_channel_mute', 'temporary_global_mute')
      AND applied_mute_duration_seconds IS NOT NULL
      AND applied_mute_duration_seconds > 0
    ) OR (
      applied_action NOT IN ('temporary_channel_mute', 'temporary_global_mute')
      AND applied_mute_duration_seconds IS NULL
    )
  ),
  CONSTRAINT chat_moderation_decisions_error_valid CHECK (
    (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 80)
    AND (error_summary IS NULL OR char_length(error_summary) BETWEEN 1 AND 500)
  ),
  CONSTRAINT chat_moderation_decisions_reversal_valid CHECK (
    (
      processing_status = 'reversed'
      AND reversed_at IS NOT NULL
      AND reversed_by IS NOT NULL
      AND reversal_reason IS NOT NULL
      AND char_length(btrim(reversal_reason)) BETWEEN 1 AND 500
    ) OR (
      processing_status <> 'reversed'
      AND reversed_at IS NULL
      AND reversed_by IS NULL
      AND reversal_reason IS NULL
    )
  ),
  CONSTRAINT chat_moderation_decisions_metadata_valid CHECK (
    jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384
  )
);

CREATE INDEX IF NOT EXISTS chat_moderation_decisions_message_idx
  ON chat_moderation_decisions (message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_moderation_decisions_player_idx
  ON chat_moderation_decisions (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_moderation_decisions_processing_idx
  ON chat_moderation_decisions (processing_status, created_at ASC);
CREATE INDEX IF NOT EXISTS chat_moderation_decisions_review_idx
  ON chat_moderation_decisions (created_at ASC)
  WHERE human_review_status = 'pending';

DROP TRIGGER IF EXISTS chat_moderation_decisions_set_updated_at ON chat_moderation_decisions;
CREATE TRIGGER chat_moderation_decisions_set_updated_at
BEFORE UPDATE ON chat_moderation_decisions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS chat_mutes (
  id uuid PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  scope text NOT NULL,
  channel_id uuid NULL REFERENCES chat_channels(id) ON DELETE RESTRICT,
  source text NOT NULL,
  reason_category text NOT NULL,
  reason text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NULL,
  actor_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  moderation_decision_id uuid NULL
    REFERENCES chat_moderation_decisions(decision_id) ON DELETE SET NULL,
  idempotency_key text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  revoked_by text NULL,
  revocation_reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_mutes_scope_valid CHECK (
    (scope = 'global' AND channel_id IS NULL)
    OR (scope = 'channel' AND channel_id IS NOT NULL)
  ),
  CONSTRAINT chat_mutes_source_valid CHECK (
    source IN ('system', 'automated_moderation', 'human_moderator')
  ),
  CONSTRAINT chat_mutes_actor_type_valid CHECK (
    actor_type IN ('system', 'moderation_service', 'human_moderator')
  ),
  CONSTRAINT chat_mutes_reason_valid CHECK (
    char_length(btrim(reason_category)) BETWEEN 1 AND 64
    AND char_length(btrim(reason)) BETWEEN 1 AND 500
  ),
  CONSTRAINT chat_mutes_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT chat_mutes_idempotency_key_valid CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 128
  ),
  CONSTRAINT chat_mutes_revocation_valid CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (
      revoked_at >= created_at
      AND revoked_by IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND char_length(btrim(revoked_by)) BETWEEN 1 AND 128
      AND char_length(btrim(revocation_reason)) BETWEEN 1 AND 500
    )
  ),
  CONSTRAINT chat_mutes_actor_metadata_valid CHECK (
    jsonb_typeof(actor_metadata) = 'object'
    AND pg_column_size(actor_metadata) <= 16384
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_mutes_idempotency_unique_idx
  ON chat_mutes (source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_mutes_decision_unique_idx
  ON chat_mutes (moderation_decision_id)
  WHERE moderation_decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_mutes_active_global_idx
  ON chat_mutes (player_id, expires_at)
  WHERE revoked_at IS NULL AND scope = 'global';
CREATE INDEX IF NOT EXISTS chat_mutes_active_channel_idx
  ON chat_mutes (player_id, channel_id, expires_at)
  WHERE revoked_at IS NULL AND scope = 'channel';

DROP TRIGGER IF EXISTS chat_mutes_set_updated_at ON chat_mutes;
CREATE TRIGGER chat_mutes_set_updated_at
BEFORE UPDATE ON chat_mutes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
