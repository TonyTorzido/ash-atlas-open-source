-- Match the geography expressions used by bounded Kingdom distance queries.
CREATE INDEX IF NOT EXISTS kingdom_seats_geography_active_gix
  ON kingdom_seats USING gist ((geom::geography)) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS kingdom_cots_geography_active_gix
  ON kingdom_cots USING gist ((geom::geography)) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS kingdom_decorations_geography_active_gix
  ON kingdom_decorations USING gist ((geom::geography)) WHERE status = 'active';

-- Historic chat replay rows predate receipt-only storage. Remove message bodies and
-- recipient arrays while retaining the stable identifiers required for idempotency.
UPDATE kingdom_requests
SET response = jsonb_build_object(
  'kingdomId', response ->> 'kingdomId',
  'messageId', response #>> '{message,id}'
)
WHERE operation = 'chat_send'
  AND (response ? 'message' OR response ? 'recipientPlayerIds');
