ALTER TABLE telemetry.player_snapshots
  ALTER COLUMN party_id TYPE text
  USING party_id::text;

