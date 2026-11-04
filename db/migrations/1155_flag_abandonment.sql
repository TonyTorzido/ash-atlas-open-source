-- Flag abandonment  (flags of owners inactive for a month). A
-- daily sweep removes personal flags whose owner has not been seen for 30
-- days, exactly like a destroyed flag (the row and whatever stands on it go;
-- the land becomes claimable). Kingdom, Castle and City flags are skipped.
--
-- One audit row per abandoned flag. The flag id is the key, so two servers
-- sweeping at once can never record (or remove) the same flag twice.
CREATE TABLE IF NOT EXISTS flag_abandonments (
  flag_id uuid PRIMARY KEY,
  owner_player_id text NOT NULL,
  flag_name text NOT NULL,
  anchor_kind text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  owner_last_seen_at timestamptz NOT NULL,
  abandoned_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT 'owner_inactive_30_days'
    CHECK (reason IN ('owner_inactive_30_days'))
);

CREATE INDEX IF NOT EXISTS flag_abandonments_owner_idx
  ON flag_abandonments (owner_player_id, abandoned_at DESC);

COMMENT ON TABLE flag_abandonments IS
  'Audit of personal flags removed because their owner was inactive for 30 days (owner kept as text: no FK, players may be deleted).';
