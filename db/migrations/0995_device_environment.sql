BEGIN;

-- Device environment summaries (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md §8.9).
-- One row per attestation request that carried an environment block. The raw
-- install id, time zone and locale are never stored: only sha256(installId) and
-- the countries derived from them. Retention follows TRUST_ATTEST_RETENTION_DAYS;
-- account deletion clears these rows explicitly (accounts are soft-deleted).

CREATE TABLE IF NOT EXISTS device_environment_reports (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attestation_id uuid NULL REFERENCES device_attestations(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  install_id_hash text NOT NULL CHECK (char_length(install_id_hash) = 64),
  install_id_persistent boolean NULL,
  install_source text NULL CHECK (install_source IS NULL OR install_source IN ('store', 'testflight', 'sideload', 'unknown')),
  emulator_hints text[] NOT NULL DEFAULT '{}' CHECK (cardinality(emulator_hints) <= 16),
  root_hints text[] NOT NULL DEFAULT '{}' CHECK (cardinality(root_hints) <= 16),
  debugger_attached boolean NULL,
  dev_options boolean NULL,
  adb_enabled boolean NULL,
  auto_time_enabled boolean NULL,
  vpn_active boolean NULL,
  sim_country text NULL CHECK (sim_country IS NULL OR sim_country ~ '^[A-Z]{2}$'),
  network_country text NULL CHECK (network_country IS NULL OR network_country ~ '^[A-Z]{2}$'),
  cell_countries text[] NOT NULL DEFAULT '{}' CHECK (cardinality(cell_countries) <= 8),
  time_zone_countries text[] NOT NULL DEFAULT '{}' CHECK (cardinality(time_zone_countries) <= 32),
  locale_country text NULL CHECK (locale_country IS NULL OR locale_country ~ '^[A-Z]{2}$'),
  gps_countries text[] NOT NULL DEFAULT '{}' CHECK (cardinality(gps_countries) <= 32),
  play_integrity jsonb NULL
    CHECK (play_integrity IS NULL OR (jsonb_typeof(play_integrity) = 'object' AND pg_column_size(play_integrity) <= 2048)),
  devicecheck_bit0 boolean NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_environment_reports_account_idx
  ON device_environment_reports (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS device_environment_reports_install_idx
  ON device_environment_reports (install_id_hash, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS device_environment_reports_created_idx
  ON device_environment_reports (created_at);

-- Latest Apple DeviceCheck token per account, kept only while
-- TRUST_DEVICECHECK_BIT_SET_ENABLED so a spoofing lock can set bit0 on the device.
CREATE TABLE IF NOT EXISTS devicecheck_device_tokens (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  device_token text NOT NULL CHECK (char_length(device_token) BETWEEN 4 AND 16384),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devicecheck_device_tokens_updated_idx
  ON devicecheck_device_tokens (updated_at);

COMMIT;
