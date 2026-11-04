-- Email one-time-code sign-in. The runtime flag AUTH_EMAIL_LOGIN_ENABLED stays
-- false until a real sender is configured. Raw codes are never stored: only
-- HMAC-SHA256(AUTH_EMAIL_CODE_HMAC_KEY, ...) hex digests.
BEGIN;

ALTER TABLE account_identities DROP CONSTRAINT IF EXISTS account_identities_provider_check;
ALTER TABLE account_identities ADD CONSTRAINT account_identities_provider_check
  CHECK (provider IN ('google', 'apple', 'email'));

ALTER TABLE account_identities DROP CONSTRAINT IF EXISTS account_identities_email_shape_check;
ALTER TABLE account_identities ADD CONSTRAINT account_identities_email_shape_check CHECK (
  (provider IN ('google', 'email') AND email IS NOT NULL AND email_verified = true
     AND char_length(email) BETWEEN 3 AND 320)
  OR (provider = 'apple' AND (email IS NULL OR char_length(email) BETWEEN 3 AND 320)
     AND (email_verified IS NULL OR email_verified IN (true, false))));

ALTER TABLE test_access_email_grants
  DROP CONSTRAINT IF EXISTS test_access_email_grants_claimed_identity_shape_check;
ALTER TABLE test_access_email_grants
  ADD CONSTRAINT test_access_email_grants_claimed_identity_shape_check CHECK (
    (status = 'claimed' AND claimed_provider IN ('google', 'apple', 'email')
       AND claimed_subject IS NOT NULL)
    OR (status <> 'claimed' AND claimed_provider IS NULL AND claimed_subject IS NULL));

-- 0680 required claimed_google_subject for every claim. Non-Google claims carry
-- their subject in claimed_provider/claimed_subject (0850) instead.
ALTER TABLE test_access_email_grants
  DROP CONSTRAINT IF EXISTS test_access_email_grants_state_valid;
ALTER TABLE test_access_email_grants
  ADD CONSTRAINT test_access_email_grants_state_valid CHECK (
    (
      status = 'active'
      AND claimed_account_id IS NULL
      AND claimed_google_subject IS NULL
      AND claimed_at IS NULL
      AND revoked_at IS NULL
    )
    OR
    (
      status = 'claimed'
      AND claimed_account_id IS NOT NULL
      AND (claimed_google_subject IS NOT NULL OR claimed_provider IN ('apple', 'email'))
      AND claimed_at IS NOT NULL
      AND revoked_at IS NULL
    )
    OR
    (
      status = 'revoked'
      AND claimed_account_id IS NULL
      AND claimed_google_subject IS NULL
      AND claimed_at IS NULL
      AND revoked_at IS NOT NULL
    )
  );

-- Canonical mailbox for alias-proof uniqueness and cross-provider link checks.
-- Must stay identical to canonicalEmail() in
-- apps/server/src/auth/email/emailDomainPolicy.ts: lowercase, "+tag" stripped
-- for every domain, and for gmail.com/googlemail.com dots removed with
-- googlemail.com mapped to gmail.com.
CREATE OR REPLACE FUNCTION auth_canonical_email(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN parts.domain_part IS NULL THEN parts.v
    WHEN parts.domain_part IN ('gmail.com', 'googlemail.com')
      THEN replace(split_part(parts.local_part, '+', 1), '.', '') || '@gmail.com'
    ELSE split_part(parts.local_part, '+', 1) || '@' || parts.domain_part
  END
  FROM (
    SELECT input.v,
           substring(input.v FROM '^(.*)@[^@]*$') AS local_part,
           substring(input.v FROM '@([^@]*)$') AS domain_part
    FROM (SELECT lower(btrim(value)) AS v) AS input
  ) AS parts
$$;

-- Generated, so existing Google/Apple rows are backfilled here and every
-- insert/update path (including deletion scrubs) keeps it in step.
ALTER TABLE account_identities
  ADD COLUMN IF NOT EXISTS email_canonical text
  GENERATED ALWAYS AS (auth_canonical_email(email_normalized)) STORED;

CREATE INDEX IF NOT EXISTS account_identities_verified_canonical_email_idx
  ON account_identities (email_canonical, account_id)
  WHERE email_canonical IS NOT NULL AND email_verified = true;

-- email_normalized holds the canonical mailbox (auth_canonical_email), so
-- per-email limits and code lookup cover every alias of one inbox.
CREATE TABLE IF NOT EXISTS email_login_codes (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL CHECK (char_length(email_normalized) BETWEEN 3 AND 320),
  code_hash text NOT NULL CHECK (char_length(code_hash) = 64),
  purpose text NOT NULL CHECK (purpose IN ('signin', 'link')),
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  session_id uuid NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  network_hash text NULL CHECK (network_hash IS NULL OR char_length(network_hash) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  consumed_at timestamptz NULL,
  invalidated_at timestamptz NULL,
  invalidation_reason text NULL CHECK (invalidation_reason IS NULL
    OR invalidation_reason IN ('superseded', 'attempts_exhausted', 'account_deleted')),
  send_status text NOT NULL DEFAULT 'pending'
    CHECK (send_status IN ('pending', 'sent', 'logged', 'failed')),
  send_provider text NULL CHECK (send_provider IS NULL OR char_length(send_provider) <= 32),
  send_message_id text NULL CHECK (send_message_id IS NULL OR char_length(send_message_id) <= 256),
  send_error text NULL CHECK (send_error IS NULL OR char_length(send_error) <= 1000),
  CHECK (expires_at > created_at),
  CHECK ((purpose = 'signin' AND account_id IS NULL AND session_id IS NULL)
      OR (purpose = 'link' AND account_id IS NOT NULL AND session_id IS NOT NULL)),
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
  CHECK ((invalidated_at IS NULL) = (invalidation_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS email_login_codes_email_created_idx
  ON email_login_codes (email_normalized, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS email_login_codes_expiry_idx
  ON email_login_codes (expires_at);
CREATE INDEX IF NOT EXISTS email_login_codes_session_idx
  ON email_login_codes (session_id)
  WHERE session_id IS NOT NULL;

COMMIT;
