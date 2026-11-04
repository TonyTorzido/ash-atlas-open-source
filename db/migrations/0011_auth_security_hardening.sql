ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS session_version bigint NOT NULL DEFAULT 0
    CHECK (session_version >= 0);

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS account_session_version bigint NOT NULL DEFAULT 0
    CHECK (account_session_version >= 0);

UPDATE auth_sessions s
SET account_session_version = a.session_version
FROM accounts a
WHERE a.id = s.account_id
  AND s.account_session_version <> a.session_version;

CREATE TABLE IF NOT EXISTS auth_google_credential_uses (
  credential_hash text PRIMARY KEY,
  device_installation_id uuid NOT NULL REFERENCES device_installations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (length(credential_hash) BETWEEN 16 AND 128)
);

CREATE INDEX IF NOT EXISTS auth_google_credential_uses_expiry_idx
  ON auth_google_credential_uses (expires_at);

ALTER TABLE account_identities
  ADD CONSTRAINT account_identities_subject_length_check
    CHECK (length(provider_subject) BETWEEN 1 AND 255),
  ADD CONSTRAINT account_identities_email_length_check
    CHECK (length(email) BETWEEN 3 AND 320);

ALTER TABLE device_installations
  ADD CONSTRAINT device_installations_browser_length_check
    CHECK (browser_family IS NULL OR length(browser_family) <= 64),
  ADD CONSTRAINT device_installations_os_length_check
    CHECK (os_family IS NULL OR length(os_family) <= 64);

ALTER TABLE auth_events
  ADD CONSTRAINT auth_events_type_length_check
    CHECK (length(event_type) BETWEEN 1 AND 128),
  ADD CONSTRAINT auth_events_metadata_shape_check
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384);

ALTER TABLE account_risk_events
  ADD CONSTRAINT account_risk_events_type_length_check
    CHECK (length(event_type) BETWEEN 1 AND 128),
  ADD CONSTRAINT account_risk_events_metadata_shape_check
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384);

CREATE OR REPLACE FUNCTION revoke_sessions_when_account_disabled()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    NEW.session_version := OLD.session_version + 1;
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, now()),
        revoke_reason = COALESCE(revoke_reason, 'account_status_changed')
    WHERE account_id = OLD.id
      AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounts_revoke_sessions_when_disabled ON accounts;
CREATE TRIGGER accounts_revoke_sessions_when_disabled
BEFORE UPDATE OF status ON accounts
FOR EACH ROW
EXECUTE FUNCTION revoke_sessions_when_account_disabled();
