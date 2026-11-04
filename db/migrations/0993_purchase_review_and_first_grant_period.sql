-- Purchase review fixes (forward from 0991/0992).
--
-- * A paid webhook the server cannot match to a checkout, product or price is
--   kept as `needs_review`: never treated as done, answered non-2xx so the
--   provider keeps retrying, and listed for support to grant by hand.
-- * The one-time Atlas Pass Lumen grant remembers the paid period that earned
--   it, so refunding a later period does not claw it back.

ALTER TABLE store_notification_inbox
  DROP CONSTRAINT IF EXISTS store_notification_inbox_status_check;
ALTER TABLE store_notification_inbox
  ADD CONSTRAINT store_notification_inbox_status_check
  CHECK (status IN ('received', 'processed', 'ignored', 'failed', 'needs_review'));

DROP INDEX IF EXISTS store_notification_inbox_pending_idx;
CREATE INDEX IF NOT EXISTS store_notification_inbox_pending_idx
  ON store_notification_inbox (received_at)
  WHERE status IN ('received', 'failed', 'needs_review');

ALTER TABLE premium_pass_first_grants
  ADD COLUMN IF NOT EXISTS period_id bigint NULL
    REFERENCES premium_subscription_periods(period_id) ON DELETE RESTRICT;
