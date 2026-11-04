-- Store and provider notifications are recorded once and processed exactly
-- once (premium-currency-plan.md §6.2–§6.4). Only the normalized fields the
-- processor needs are stored, never raw provider bodies or buyer details.

CREATE TABLE IF NOT EXISTS store_notification_inbox (
  inbox_id bigserial PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('apple', 'google', 'web')),
  notification_id text NOT NULL CHECK (length(notification_id) BETWEEN 1 AND 240),
  notification_type text NOT NULL CHECK (length(notification_type) BETWEEN 1 AND 80),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(payload::text) <= 32768),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error text NULL CHECK (error IS NULL OR length(error) <= 240),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NULL,
  CONSTRAINT store_notification_inbox_unique UNIQUE (platform, notification_id)
);

CREATE INDEX IF NOT EXISTS store_notification_inbox_pending_idx
  ON store_notification_inbox (received_at) WHERE status IN ('received', 'failed');

-- Web checkouts bind a provider payment to the signed-in account and product
-- before the buyer pays; the webhook must match this row.
CREATE TABLE IF NOT EXISTS premium_web_checkouts (
  checkout_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('xsolla')),
  sku text NOT NULL REFERENCES premium_products(sku) ON DELETE RESTRICT,
  sandbox boolean NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
  purchase_id uuid NULL REFERENCES premium_purchases(purchase_id) ON DELETE RESTRICT,
  anonymized_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premium_web_checkouts_owner_shape CHECK (account_id IS NOT NULL OR anonymized_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS premium_web_checkouts_account_idx
  ON premium_web_checkouts (account_id, created_at DESC);

DROP TRIGGER IF EXISTS premium_web_checkouts_set_updated_at ON premium_web_checkouts;
CREATE TRIGGER premium_web_checkouts_set_updated_at
BEFORE UPDATE ON premium_web_checkouts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
