-- Local chat is persisted for moderation and idempotency, but its player-facing
-- delivery is live AOI only. No history endpoint may expose these rows.
ALTER TABLE chat_channels DROP CONSTRAINT IF EXISTS chat_channels_type_valid;
ALTER TABLE chat_channels ADD CONSTRAINT chat_channels_type_valid CHECK (
  channel_type IN ('public', 'local', 'kingdom', 'party', 'alliance', 'direct')
);

INSERT INTO chat_channels (
  id, channel_key, channel_type, display_name, visibility_policy,
  send_access_policy, history_retention_policy, rate_limit_policy,
  moderation_policy, active
) VALUES (
  '05000000-0000-4000-8000-000000000004',
  'local:map',
  'local',
  'Local',
  'authoritative_aoi_v1',
  'authenticated_local_v1',
  'live_session_v1',
  'public_standard_v1',
  'public_chat_v1',
  true
)
ON CONFLICT (channel_key) DO NOTHING;

INSERT INTO chat_channel_sequences (channel_id, last_sequence)
SELECT id, 0 FROM chat_channels WHERE channel_key = 'local:map'
ON CONFLICT (channel_id) DO NOTHING;
