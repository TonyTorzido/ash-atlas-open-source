CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  trust_tier text NOT NULL DEFAULT 'new'
    CHECK (trust_tier IN ('new', 'standard', 'trusted', 'restricted')),
  risk_score integer NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NULL,
  suspended_at timestamptz NULL,
  suspension_reason text NULL,
  CHECK (
    (status = 'suspended' AND suspended_at IS NOT NULL)
    OR (status <> 'suspended')
  )
);

DROP TRIGGER IF EXISTS accounts_set_updated_at ON accounts;
CREATE TRIGGER accounts_set_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS account_identities (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider = 'google'),
  provider_subject text NOT NULL CHECK (length(provider_subject) > 0),
  email text NOT NULL CHECK (length(email) > 0),
  email_verified boolean NOT NULL CHECK (email_verified = true),
  google_auth_time timestamptz NULL,
  google_auth_methods text[] NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject),
  UNIQUE (account_id, provider)
);

CREATE INDEX IF NOT EXISTS account_identities_account_idx
  ON account_identities (account_id);

DROP TRIGGER IF EXISTS account_identities_set_updated_at ON account_identities;
CREATE TRIGGER account_identities_set_updated_at
BEFORE UPDATE ON account_identities
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS device_installations (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  browser_family text NULL,
  os_family text NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  revoke_reason text NULL,
  CHECK (expires_at > created_at),
  CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS auth_sessions_account_active_idx
  ON auth_sessions (account_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
  ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS account_device_links (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  device_installation_id uuid NOT NULL REFERENCES device_installations(id) ON DELETE RESTRICT,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  login_count integer NOT NULL DEFAULT 1 CHECK (login_count > 0),
  PRIMARY KEY (account_id, device_installation_id)
);

CREATE INDEX IF NOT EXISTS account_device_links_device_idx
  ON account_device_links (device_installation_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS auth_events (
  id uuid PRIMARY KEY,
  account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  network_hash text NULL,
  network_prefix_hash text NULL,
  network_key_version text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_events_account_created_idx
  ON auth_events (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_events_device_type_created_idx
  ON auth_events (device_installation_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_events_network_type_created_idx
  ON auth_events (network_prefix_hash, event_type, created_at DESC)
  WHERE network_prefix_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS auth_events_network_hash_type_created_idx
  ON auth_events (network_hash, event_type, created_at DESC)
  WHERE network_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_risk_events (
  id uuid PRIMARY KEY,
  account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  device_installation_id uuid NULL REFERENCES device_installations(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  weight integer NOT NULL,
  dedupe_key text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_risk_events_dedupe_idx
  ON account_risk_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS account_risk_events_account_created_idx
  ON account_risk_events (account_id, created_at DESC);

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT;

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS username_normalized text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS players_account_id_unique_idx
  ON players (account_id)
  WHERE account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS players_username_normalized_unique_idx
  ON players (username_normalized)
  WHERE username_normalized IS NOT NULL;
