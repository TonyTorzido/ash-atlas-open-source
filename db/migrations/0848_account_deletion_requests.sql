CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id uuid PRIMARY KEY,
  account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  request_key text NOT NULL,
  email_normalized text NULL,
  request_source text NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification',
  requested_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NULL,
  processed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  processing_note text NULL,
  CONSTRAINT account_deletion_requests_key_length_check
    CHECK (length(request_key) BETWEEN 3 AND 380),
  CONSTRAINT account_deletion_requests_email_length_check
    CHECK (email_normalized IS NULL OR length(email_normalized) BETWEEN 3 AND 320),
  CONSTRAINT account_deletion_requests_source_check
    CHECK (request_source IN ('authenticated', 'public')),
  CONSTRAINT account_deletion_requests_status_check
    CHECK (status IN (
      'pending_verification',
      'pending_processing',
      'processing',
      'completed',
      'rejected',
      'cancelled'
    )),
  CONSTRAINT account_deletion_requests_timestamps_check
    CHECK (
      (status IN ('pending_verification', 'pending_processing') AND processed_at IS NULL)
      OR status IN ('processing', 'completed', 'rejected', 'cancelled')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_active_key_idx
  ON account_deletion_requests (request_key)
  WHERE status IN ('pending_verification', 'pending_processing', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_active_email_idx
  ON account_deletion_requests (email_normalized)
  WHERE email_normalized IS NOT NULL
    AND status IN ('pending_verification', 'pending_processing', 'processing');

CREATE INDEX IF NOT EXISTS account_deletion_requests_account_idx
  ON account_deletion_requests (account_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS account_deletion_requests_status_idx
  ON account_deletion_requests (status, requested_at ASC);
