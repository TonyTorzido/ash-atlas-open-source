BEGIN;

-- Device attestation (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md §7, §8).
-- Only summarized verdicts and hashes are stored, never raw tokens. Accounts are
-- soft-deleted, so ON DELETE CASCADE rarely fires; account deletion clears these
-- rows explicitly (A9).

CREATE TABLE IF NOT EXISTS attestation_challenges (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id uuid NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  purpose text NOT NULL CHECK (purpose IN ('session', 'relocation', 'ios_key')),
  challenge bytea NOT NULL CHECK (octet_length(challenge) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS attestation_challenges_session_idx
  ON attestation_challenges (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attestation_challenges_account_idx
  ON attestation_challenges (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attestation_challenges_expires_idx
  ON attestation_challenges (expires_at);

CREATE TABLE IF NOT EXISTS app_attest_keys (
  key_id text PRIMARY KEY CHECK (char_length(key_id) BETWEEN 1 AND 128),
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  first_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  environment text NOT NULL CHECK (environment IN ('production', 'development')),
  public_key_spki bytea NOT NULL CHECK (octet_length(public_key_spki) BETWEEN 1 AND 512),
  receipt bytea NULL CHECK (receipt IS NULL OR octet_length(receipt) <= 16384),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revoke_reason text NULL CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 64)
);
CREATE INDEX IF NOT EXISTS app_attest_keys_installation_idx
  ON app_attest_keys (device_installation_id);
CREATE INDEX IF NOT EXISTS app_attest_keys_first_account_idx
  ON app_attest_keys (first_account_id);

CREATE TABLE IF NOT EXISTS device_attestations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id uuid NULL REFERENCES auth_sessions(id) ON DELETE SET NULL,
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  method text NOT NULL CHECK (method IN ('play_integrity', 'app_attest', 'devicecheck', 'none')),
  purpose text NOT NULL CHECK (purpose IN ('session', 'relocation', 'ios_key')),
  challenge_id uuid NULL REFERENCES attestation_challenges(id) ON DELETE SET NULL,
  app_attest_key_id text NULL REFERENCES app_attest_keys(key_id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('pass', 'fail', 'unavailable')),
  assurance text NOT NULL CHECK (assurance IN
    ('attested', 'device_checked', 'unverified', 'native_legacy', 'web', 'flagged')),
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 64),
  verdict jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(verdict) = 'object' AND pg_column_size(verdict) <= 8192),
  bound_fix jsonb NULL
    CHECK (bound_fix IS NULL OR (jsonb_typeof(bound_fix) = 'object' AND pg_column_size(bound_fix) <= 1024)),
  token_hash text NULL UNIQUE CHECK (token_hash IS NULL OR char_length(token_hash) <= 128),
  ref_hash text NOT NULL UNIQUE CHECK (char_length(ref_hash) <= 128),
  shell_build integer NULL CHECK (shell_build IS NULL OR shell_build >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS device_attestations_account_idx
  ON device_attestations (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS device_attestations_created_idx
  ON device_attestations (created_at);
CREATE INDEX IF NOT EXISTS device_attestations_challenge_idx
  ON device_attestations (challenge_id) WHERE challenge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_attestations_key_idx
  ON device_attestations (app_attest_key_id) WHERE app_attest_key_id IS NOT NULL;

-- Per-fix assurance: web fixes never count toward Settled; native fixes count
-- per TRUST_SETTLE_ASSURANCE_MODE.
ALTER TABLE location_reports
  ADD COLUMN IF NOT EXISTS attestation_id uuid NULL REFERENCES device_attestations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assurance text NULL CHECK (assurance IS NULL OR assurance IN
    ('attested', 'device_checked', 'unverified', 'native_legacy', 'web', 'flagged'));
CREATE INDEX IF NOT EXISTS location_reports_attestation_idx
  ON location_reports (attestation_id) WHERE attestation_id IS NOT NULL;

ALTER TABLE account_location_state
  ADD COLUMN IF NOT EXISTS last_fix_assurance text NULL CHECK (last_fix_assurance IS NULL OR last_fix_assurance IN
    ('attested', 'device_checked', 'unverified', 'native_legacy', 'web', 'flagged'));

COMMIT;
