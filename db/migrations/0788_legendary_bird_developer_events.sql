ALTER TABLE legendary_bird_events
  ADD COLUMN IF NOT EXISTS event_source text NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS developer_operation_key text;

ALTER TABLE legendary_bird_events
  ADD CONSTRAINT legendary_bird_events_event_source_check
    CHECK (event_source IN ('daily', 'developer')),
  ADD CONSTRAINT legendary_bird_events_developer_operation_check
    CHECK (
      (event_source = 'daily' AND developer_operation_key IS NULL) OR
      (event_source = 'developer' AND developer_operation_key IS NOT NULL AND length(developer_operation_key) BETWEEN 1 AND 128)
    );

CREATE UNIQUE INDEX IF NOT EXISTS legendary_bird_events_developer_operation_key_unique
  ON legendary_bird_events (developer_operation_key)
  WHERE developer_operation_key IS NOT NULL;

COMMENT ON COLUMN legendary_bird_events.event_source IS
  'Durable provenance for daily rotation and explicitly developer-triggered events.';
COMMENT ON COLUMN legendary_bird_events.developer_operation_key IS
  'Idempotency key for a developer-triggered event; absent for ordinary daily events.';
COMMENT ON TABLE legendary_bird_events IS
  'Durable daily and developer-triggered hard-flag encounters. Pending and active events expire at their existing 24-hour cycle boundary.';
