-- Update-notice sign-ups from the public landing page while the game is open to developers only.
-- One row per normalized email; a repeat sign-up keeps the first row. No raw IP is stored: ip_hash
-- is the server's keyed network hash. No functions, so nothing depends on search_path.
-- Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS update_subscribers (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  source text NULL,
  user_agent text NULL,
  ip_hash text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz NULL,
  CONSTRAINT update_subscribers_email_check
    CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(btrim(email))),
  CONSTRAINT update_subscribers_source_check
    CHECK (source IS NULL OR length(source) BETWEEN 1 AND 64),
  CONSTRAINT update_subscribers_user_agent_check
    CHECK (user_agent IS NULL OR length(user_agent) <= 256),
  CONSTRAINT update_subscribers_ip_hash_check
    CHECK (ip_hash IS NULL OR length(ip_hash) <= 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS update_subscribers_email_idx
  ON update_subscribers (email);

CREATE INDEX IF NOT EXISTS update_subscribers_created_idx
  ON update_subscribers (created_at DESC);
