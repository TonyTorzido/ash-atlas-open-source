-- Additive: old binaries and web sessions do not need to opt into native push.
ALTER TABLE apple_auth_transactions ADD COLUMN native_return boolean NOT NULL DEFAULT false;
ALTER TABLE apple_auth_transactions ADD COLUMN native_return_state text;
ALTER TABLE apple_auth_transactions ADD CONSTRAINT apple_native_return_state_valid CHECK (
  (NOT native_return AND native_return_state IS NULL) OR
  (native_return AND intent='link' AND native_return_state IS NOT NULL AND native_return_state ~ '^[A-Za-z0-9_-]{43}$')
);
ALTER TABLE device_installations ADD COLUMN native_push_session_id uuid REFERENCES auth_sessions(id) ON DELETE SET NULL;
UPDATE device_installations d SET native_push_session_id=s.id FROM (
  SELECT DISTINCT ON (device_installation_id) device_installation_id,id FROM auth_sessions
  WHERE device_installation_id IS NOT NULL ORDER BY device_installation_id,created_at DESC,id DESC
) s WHERE s.device_installation_id=d.id;

CREATE TABLE native_push_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_installation_id uuid NOT NULL UNIQUE REFERENCES device_installations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  provider text NOT NULL CHECK (provider IN ('apns', 'fcm')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  binding_epoch integer NOT NULL DEFAULT 1 CHECK (binding_epoch > 0),
  token_version integer NOT NULL DEFAULT 1 CHECK (token_version > 0),
  token_hash text,
  token_encrypted jsonb,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((token_hash IS NULL) = (token_encrypted IS NULL)),
  CHECK (NOT enabled OR token_encrypted IS NOT NULL),
  CHECK ((platform = 'ios' AND provider = 'apns') OR (platform = 'android' AND provider = 'fcm'))
);
CREATE UNIQUE INDEX native_push_token_unique ON native_push_bindings(provider, environment, token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE player_push_preferences (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  direct_messages boolean NOT NULL DEFAULT true,
  invitations boolean NOT NULL DEFAULT true,
  packages boolean NOT NULL DEFAULT true,
  quiet_start integer CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end integer CHECK (quiet_end BETWEEN 0 AND 1439),
  time_zone text NOT NULL DEFAULT 'UTC',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);

CREATE TABLE native_push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  binding_id uuid NOT NULL REFERENCES native_push_bindings(id) ON DELETE CASCADE,
  binding_epoch integer NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('direct_message', 'party_invite', 'kingdom_invite', 'package')),
  source_id text NOT NULL,
  collapse_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_id uuid,
  leased_until timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'suppressed', 'failed')),
  sent_at timestamptz,
  result_code text,
  UNIQUE (event_key, binding_id, binding_epoch)
);
CREATE INDEX native_push_pending ON native_push_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX native_push_rate ON native_push_deliveries(binding_id, sent_at) WHERE status = 'sent';

-- Session revocation and replacement invalidate the epoch in the same transaction.
-- The installation is the native cookie jar's existing auth device, never the external browser's.
CREATE FUNCTION invalidate_native_push_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE device_installations SET native_push_session_id=NEW.id WHERE id=NEW.device_installation_id;
    UPDATE native_push_bindings SET enabled = false, token_hash = NULL, token_encrypted = NULL,
      binding_epoch = binding_epoch + 1, updated_at = now()
      WHERE device_installation_id = NEW.device_installation_id AND session_id <> NEW.id;
  ELSIF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE native_push_bindings SET enabled = false, token_hash = NULL, token_encrypted = NULL,
      binding_epoch = binding_epoch + 1, updated_at = now() WHERE session_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_push_session_created AFTER INSERT ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION invalidate_native_push_session();
CREATE TRIGGER native_push_session_revoked AFTER UPDATE OF revoked_at ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION invalidate_native_push_session();
