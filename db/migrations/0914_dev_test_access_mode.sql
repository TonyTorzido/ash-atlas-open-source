-- Third test-access mode: 'dev' admits only developer/admin Google subjects plus
-- accounts the administrator has explicitly placed on the dev-access list.
ALTER TABLE test_access_settings
  DROP CONSTRAINT IF EXISTS test_access_settings_access_mode_check;

ALTER TABLE test_access_settings
  ADD CONSTRAINT test_access_settings_access_mode_check
  CHECK (access_mode IN ('open', 'closed', 'dev'));

-- Dev-access list. Rows are only ever 'approved' through an explicit
-- administrator decision on an existing account; blocked sign-ins may record a
-- 'pending' request, which grants nothing.
CREATE TABLE IF NOT EXISTS dev_access_entries (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
  requested_at timestamptz NULL,
  decided_at timestamptz NULL,
  decided_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  decision_note text NULL CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dev_access_entries_status_idx
  ON dev_access_entries (status, updated_at, account_id);

ALTER TABLE test_access_events
  DROP CONSTRAINT IF EXISTS test_access_events_event_type_check;

ALTER TABLE test_access_events
  ADD CONSTRAINT test_access_events_event_type_check CHECK (event_type IN (
    'pending_requested',
    'preapproval_created',
    'preapproval_claimed',
    'preapproval_revoked',
    'account_approved',
    'account_denied',
    'account_revoked',
    'account_restored',
    'bootstrap_admin_approved',
    'development_auto_approved',
    'unauthorized_admin_rejected',
    'existing_account_backfilled',
    'access_mode_changed',
    'dev_access_requested',
    'dev_access_approved',
    'dev_access_denied',
    'dev_access_revoked'
  ));
