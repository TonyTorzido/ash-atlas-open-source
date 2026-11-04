-- Shared scoped Atlas Chats and account-level mobile pin preferences.

ALTER TABLE chat_channels DROP CONSTRAINT IF EXISTS chat_channels_type_valid;
ALTER TABLE chat_channels ADD CONSTRAINT chat_channels_type_valid CHECK (
  channel_type IN ('public', 'local', 'city', 'kingdom', 'party', 'alliance', 'direct')
);

ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_body_valid;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_body_valid CHECK (
  char_length(body) BETWEEN 1 AND 500
  AND body ~ '[^[:space:]]'
  AND position(chr(13) in body) = 0
);

INSERT INTO chat_channels (
  id, channel_key, channel_type, display_name, visibility_policy,
  send_access_policy, history_retention_policy, rate_limit_policy,
  moderation_policy, active
)
SELECT gen_random_uuid(), 'city:' || city.id::text, 'city', 'City',
       'current_city_member_v1', 'current_city_member_v1', 'bounded_scoped_v1',
       'public_standard_v1', 'public_chat_v1', city.active
FROM cities city
ON CONFLICT (channel_key) DO UPDATE SET
  active = EXCLUDED.active,
  channel_type = EXCLUDED.channel_type,
  display_name = EXCLUDED.display_name,
  visibility_policy = EXCLUDED.visibility_policy,
  send_access_policy = EXCLUDED.send_access_policy,
  history_retention_policy = EXCLUDED.history_retention_policy;

INSERT INTO chat_channels (
  id, channel_key, channel_type, display_name, visibility_policy,
  send_access_policy, history_retention_policy, rate_limit_policy,
  moderation_policy, active
)
SELECT gen_random_uuid(), 'kingdom:' || kingdom.id::text, 'kingdom', 'Kingdom',
       'current_kingdom_member_v1', 'current_kingdom_member_v1', 'bounded_scoped_v1',
       'public_standard_v1', 'public_chat_v1', kingdom.status = 'active'
FROM kingdoms kingdom
ON CONFLICT (channel_key) DO UPDATE SET
  active = EXCLUDED.active,
  channel_type = EXCLUDED.channel_type,
  display_name = EXCLUDED.display_name,
  visibility_policy = EXCLUDED.visibility_policy,
  send_access_policy = EXCLUDED.send_access_policy,
  history_retention_policy = EXCLUDED.history_retention_policy;

INSERT INTO chat_channel_sequences (channel_id, last_sequence)
SELECT channel.id, 0
FROM chat_channels channel
WHERE channel.channel_type IN ('city', 'kingdom')
ON CONFLICT (channel_id) DO NOTHING;

-- Preserve the existing Kingdom chat history while moving future traffic to
-- the shared durable chat pipeline. Legacy rows remain as read-only audit data.
WITH legacy AS (
  SELECT message.id,
         channel.id AS channel_id,
         row_number() OVER (
           PARTITION BY message.kingdom_id
           ORDER BY message.created_at, message.id
         )::bigint AS sequence_number,
         message.sender_player_id,
         player.username AS sender_display_name,
         message.content AS body,
         message.created_at
  FROM kingdom_chat_messages message
  JOIN chat_channels channel
    ON channel.channel_key = 'kingdom:' || message.kingdom_id::text
  JOIN players player ON player.id = message.sender_player_id
)
INSERT INTO chat_messages (
  id, channel_id, sequence_number, sender_player_id, sender_display_name, body,
  client_request_id, message_status, moderation_status, created_at, updated_at
)
SELECT id, channel_id, sequence_number, sender_player_id, sender_display_name, body,
       id, 'visible', 'clear', created_at, created_at
FROM legacy
ON CONFLICT DO NOTHING;

UPDATE chat_channel_sequences sequence
SET last_sequence = source.maximum_sequence
FROM (
  SELECT channel_id, max(sequence_number) AS maximum_sequence
  FROM chat_messages
  GROUP BY channel_id
) source
WHERE sequence.channel_id = source.channel_id
  AND sequence.last_sequence < source.maximum_sequence;

CREATE TABLE IF NOT EXISTS account_chat_preferences (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  pinned_categories text[] NOT NULL DEFAULT ARRAY[
    'general', 'trading', 'hunting', 'local'
  ]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_chat_preferences_pins_valid CHECK (
    cardinality(pinned_categories) BETWEEN 0 AND 4
    AND pinned_categories <@ ARRAY[
      'general', 'trading', 'hunting', 'local', 'city', 'kingdom'
    ]::text[]
    AND (pinned_categories[2] IS NULL OR pinned_categories[1] <> pinned_categories[2])
    AND (pinned_categories[3] IS NULL OR (
      pinned_categories[1] <> pinned_categories[3]
      AND pinned_categories[2] <> pinned_categories[3]
    ))
    AND (pinned_categories[4] IS NULL OR (
      pinned_categories[1] <> pinned_categories[4]
      AND pinned_categories[2] <> pinned_categories[4]
      AND pinned_categories[3] <> pinned_categories[4]
    ))
  )
);

DROP TRIGGER IF EXISTS account_chat_preferences_set_updated_at
  ON account_chat_preferences;
CREATE TRIGGER account_chat_preferences_set_updated_at
BEFORE UPDATE ON account_chat_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
