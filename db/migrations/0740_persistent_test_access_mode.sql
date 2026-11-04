CREATE TABLE IF NOT EXISTS test_access_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  access_mode text NOT NULL DEFAULT 'closed'
    CHECK (access_mode IN ('open', 'closed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO test_access_settings (singleton, access_mode)
VALUES (true, 'closed')
ON CONFLICT (singleton) DO NOTHING;

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
    'access_mode_changed'
  ));
