BEGIN;

-- Append-only ledger of device GPS fixes (relocation today, passive later).
-- seq is assigned per account by the server inside the recording transaction
-- through account_location_state.last_seq.
CREATE TABLE IF NOT EXISTS location_reports (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  player_id text NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  source text NOT NULL CHECK (source IN ('relocation', 'passive')),
  request_id text NULL CHECK (request_id IS NULL OR char_length(request_id) <= 128),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  accuracy_m double precision NULL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  client_platform text NULL CHECK (client_platform IS NULL OR client_platform IN ('web', 'ios', 'android')),
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  network_hash text NULL,
  network_prefix_hash text NULL,
  device_time_zone text NULL CHECK (device_time_zone IS NULL OR char_length(device_time_zone) <= 64),
  received_at timestamptz NOT NULL DEFAULT now(),
  prev_report_id uuid NULL REFERENCES location_reports(id) ON DELETE SET NULL,
  distance_m double precision NULL CHECK (distance_m IS NULL OR distance_m >= 0),
  elapsed_ms bigint NULL CHECK (elapsed_ms IS NULL OR elapsed_ms >= 0),
  implied_kmh double precision NULL CHECK (implied_kmh IS NULL OR implied_kmh >= 0),
  speed_bucket text NULL CHECK (speed_bucket IS NULL OR speed_bucket IN ('stationary', 'walk', 'cycle', 'car', 'rail', 'air', 'impossible')),
  verdict text NOT NULL CHECK (verdict IN ('accepted', 'shadow_rejected', 'rejected', 'travel_failed')),
  verdict_reason text NULL CHECK (verdict_reason IS NULL OR char_length(verdict_reason) <= 64),
  features jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object' AND pg_column_size(features) <= 8192),
  score double precision NOT NULL DEFAULT 0,
  UNIQUE (account_id, seq)
);

CREATE INDEX IF NOT EXISTS location_reports_account_received_idx
  ON location_reports (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS location_reports_received_idx
  ON location_reports (received_at);
-- Retention deletes rely on these for ON DELETE SET NULL lookups.
CREATE INDEX IF NOT EXISTS location_reports_prev_report_idx
  ON location_reports (prev_report_id) WHERE prev_report_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_location_state (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_accepted_report_id uuid NULL REFERENCES location_reports(id) ON DELETE SET NULL,
  last_fix_lat double precision NULL,
  last_fix_lon double precision NULL,
  last_fix_accuracy_m double precision NULL,
  last_fix_at timestamptz NULL,
  last_land_action_at timestamptz NULL,
  last_land_action_lat double precision NULL,
  last_land_action_lon double precision NULL,
  land_action_hold_until timestamptz NULL,
  land_action_hold_reason text NULL CHECK (land_action_hold_reason IS NULL OR land_action_hold_reason IN ('relocation_cooldown', 'transit', 'settle')),
  relocations_7d_far integer NOT NULL DEFAULT 0 CHECK (relocations_7d_far >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_location_state_last_accepted_report_idx
  ON account_location_state (last_accepted_report_id) WHERE last_accepted_report_id IS NOT NULL;

COMMIT;
