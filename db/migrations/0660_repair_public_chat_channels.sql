-- Repair the authoritative public chat catalog without replacing channel identities
-- or disturbing durable messages and read state.
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
  ),
  (
    '05000000-0000-4000-8000-000000000004', 'local:map', 'local', 'Local',
    'authoritative_aoi_v1', 'authenticated_local_v1', 'live_session_v1',
    'public_standard_v1', 'public_chat_v1', true
  )
ON CONFLICT (channel_key) DO UPDATE SET
  channel_type = EXCLUDED.channel_type,
  display_name = EXCLUDED.display_name,
  visibility_policy = EXCLUDED.visibility_policy,
  send_access_policy = EXCLUDED.send_access_policy,
  history_retention_policy = EXCLUDED.history_retention_policy,
  rate_limit_policy = EXCLUDED.rate_limit_policy,
  moderation_policy = EXCLUDED.moderation_policy,
  active = true;

INSERT INTO chat_channel_sequences (channel_id, last_sequence)
SELECT id, 0
FROM chat_channels
WHERE channel_key IN (
  'public:general',
  'public:trading',
  'public:hunting',
  'local:map'
)
ON CONFLICT (channel_id) DO NOTHING;
