-- Gated Sign in with Apple storage.  The runtime flag remains false until the
-- Services ID, key, and revocation-encryption key are configured out of band.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'account_identities'::regclass
      AND conname = 'account_identities_provider_check'
  ) THEN
    ALTER TABLE account_identities DROP CONSTRAINT account_identities_provider_check;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'account_identities'::regclass
      AND conname = 'account_identities_email_length_check'
  ) THEN
    ALTER TABLE account_identities DROP CONSTRAINT account_identities_email_length_check;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'account_identities'::regclass
      AND conname = 'account_identities_email_normalized_valid'
  ) THEN
    ALTER TABLE account_identities DROP CONSTRAINT account_identities_email_normalized_valid;
  END IF;
END
$$;

ALTER TABLE account_identities
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN email_verified DROP NOT NULL,
  ALTER COLUMN email_normalized DROP NOT NULL;

ALTER TABLE account_identities
  ADD COLUMN IF NOT EXISTS apple_email_private boolean NULL,
  ADD COLUMN IF NOT EXISTS apple_email_forwarding_enabled boolean NULL,
  ADD COLUMN IF NOT EXISTS identity_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS revocation_reason text NULL,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS apple_refresh_token_key_id text NULL,
  ADD COLUMN IF NOT EXISTS apple_refresh_token_iv text NULL,
  ADD COLUMN IF NOT EXISTS apple_refresh_token_tag text NULL,
  ADD COLUMN IF NOT EXISTS apple_refresh_token_ciphertext text NULL,
  ADD COLUMN IF NOT EXISTS apple_refresh_token_validated_at timestamptz NULL;

ALTER TABLE account_identities
  ADD CONSTRAINT account_identities_provider_check
    CHECK (provider IN ('google', 'apple')),
  ADD CONSTRAINT account_identities_email_shape_check
    CHECK (
      (provider = 'google' AND email IS NOT NULL AND email_verified = true
        AND char_length(email) BETWEEN 3 AND 320)
      OR
      (provider = 'apple' AND (email IS NULL OR char_length(email) BETWEEN 3 AND 320)
        AND (email_verified IS NULL OR email_verified IN (true, false)))
    ),
  ADD CONSTRAINT account_identities_identity_status_check
    CHECK (identity_status IN ('active', 'revoked')),
  ADD CONSTRAINT account_identities_revocation_shape_check
    CHECK ((identity_status = 'active' AND revoked_at IS NULL)
      OR (identity_status = 'revoked' AND revoked_at IS NOT NULL)),
  ADD CONSTRAINT account_identities_refresh_token_shape_check
    CHECK (
      (apple_refresh_token_key_id IS NULL AND apple_refresh_token_iv IS NULL
        AND apple_refresh_token_tag IS NULL AND apple_refresh_token_ciphertext IS NULL)
      OR
      (provider = 'apple'
        AND apple_refresh_token_key_id IS NOT NULL
        AND apple_refresh_token_iv IS NOT NULL
        AND apple_refresh_token_tag IS NOT NULL
        AND apple_refresh_token_ciphertext IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS account_identities_verified_email_idx
  ON account_identities (email_normalized, account_id)
  WHERE email_normalized IS NOT NULL AND email_verified = true;
CREATE INDEX IF NOT EXISTS account_identities_apple_email_idx
  ON account_identities (email_normalized, account_id)
  WHERE provider = 'apple' AND email_normalized IS NOT NULL;

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS identity_id uuid NULL;

UPDATE auth_sessions s
SET identity_id = i.id
FROM account_identities i
WHERE s.identity_id IS NULL
  AND i.account_id = s.account_id
  AND i.provider = 'google';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth_sessions WHERE identity_id IS NULL) THEN
    RAISE EXCEPTION '0850 cannot assign an identity to every existing auth session';
  END IF;
END
$$;

ALTER TABLE auth_sessions
  ALTER COLUMN identity_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'auth_sessions'::regclass
      AND conname = 'auth_sessions_identity_fkey'
  ) THEN
    ALTER TABLE auth_sessions
      ADD CONSTRAINT auth_sessions_identity_fkey
      FOREIGN KEY (identity_id) REFERENCES account_identities(id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS auth_sessions_identity_active_idx
  ON auth_sessions (identity_id, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE test_access_email_grants
  ADD COLUMN IF NOT EXISTS claimed_provider text NULL,
  ADD COLUMN IF NOT EXISTS claimed_subject text NULL;

UPDATE test_access_email_grants
SET claimed_provider = 'google', claimed_subject = claimed_google_subject
WHERE claimed_google_subject IS NOT NULL
  AND claimed_provider IS NULL;

ALTER TABLE test_access_email_grants
  ADD CONSTRAINT test_access_email_grants_claimed_identity_shape_check
    CHECK (
      (status = 'claimed' AND claimed_provider IN ('google', 'apple')
        AND claimed_subject IS NOT NULL)
      OR
      (status <> 'claimed' AND claimed_provider IS NULL AND claimed_subject IS NULL)
    );

CREATE TABLE IF NOT EXISTS apple_auth_transactions (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (char_length(state_hash) = 64),
  nonce_hash text NOT NULL CHECK (char_length(nonce_hash) = 64),
  intent text NOT NULL CHECK (intent IN ('signin', 'link')),
  return_path text NOT NULL CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%'),
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  session_id uuid NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  network_hash text NULL CHECK (network_hash IS NULL OR char_length(network_hash) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz NULL,
  consumed_at timestamptz NULL,
  failure_code text NULL,
  CHECK (expires_at > created_at),
  CHECK ((intent = 'signin' AND account_id IS NULL AND session_id IS NULL)
    OR (intent = 'link' AND account_id IS NOT NULL AND session_id IS NOT NULL)),
  CHECK (consumed_at IS NULL OR claimed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS apple_auth_transactions_expiry_idx
  ON apple_auth_transactions (expires_at);
CREATE INDEX IF NOT EXISTS apple_auth_transactions_account_idx
  ON apple_auth_transactions (account_id, created_at DESC)
  WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS apple_revocation_jobs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL REFERENCES account_identities(id) ON DELETE RESTRICT,
  deletion_request_id uuid NULL REFERENCES account_deletion_requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'completed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz NULL,
  completed_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS apple_revocation_jobs_active_identity_idx
  ON apple_revocation_jobs (identity_id)
  WHERE status IN ('pending', 'processing', 'retry');
CREATE INDEX IF NOT EXISTS apple_revocation_jobs_due_idx
  ON apple_revocation_jobs (status, next_attempt_at, created_at);

ALTER TABLE account_deletion_requests
  ADD COLUMN IF NOT EXISTS apple_revocation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS apple_revocation_completed_at timestamptz NULL;

COMMIT;
