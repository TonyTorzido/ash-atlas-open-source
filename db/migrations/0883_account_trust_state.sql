BEGIN;

-- Decaying per-account log-odds trust score (D12) and its signal ledger.
-- enforcement_tier stays 0 until the ladder goes live (wave 3).
CREATE TABLE IF NOT EXISTS account_trust_state (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  logodds double precision NOT NULL DEFAULT 0,
  logodds_updated_at timestamptz NOT NULL DEFAULT now(),
  peak_logodds double precision NOT NULL DEFAULT 0,
  shadow_tier smallint NOT NULL DEFAULT 0 CHECK (shadow_tier BETWEEN 0 AND 6),
  enforcement_tier smallint NOT NULL DEFAULT 0 CHECK (enforcement_tier BETWEEN 0 AND 6),
  tier_entered_at timestamptz NULL,
  tier_exit_eligible_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_trust_state_logodds_idx
  ON account_trust_state (logodds DESC);

CREATE TABLE IF NOT EXISTS account_trust_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('signal', 'shadow_tier_change', 'tier_change', 'reversal', 'note')),
  rule text NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 64),
  weight double precision NOT NULL DEFAULT 0,
  logodds_after double precision NOT NULL,
  location_report_id uuid NULL REFERENCES location_reports(id) ON DELETE SET NULL,
  dedupe_key text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz NULL,
  reversal_id uuid NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS account_trust_events_dedupe_idx
  ON account_trust_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_trust_events_account_created_idx
  ON account_trust_events (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_trust_events_rule_created_idx
  ON account_trust_events (rule, created_at DESC);
-- Location report retention relies on this for ON DELETE SET NULL lookups.
CREATE INDEX IF NOT EXISTS account_trust_events_location_report_idx
  ON account_trust_events (location_report_id) WHERE location_report_id IS NOT NULL;

COMMIT;
