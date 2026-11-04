-- Atlas Pass subscriptions (premium-currency-plan.md §5.2, §6.2, §6.7).
-- Dormant behind ATLAS_PASS_ENABLED=false. The pass grants Lumen, which is an
-- inventory item since 0917: 120 once per account ever, then 12 per subscribed
-- UTC calendar day, credited when the player next asks for the entitlement.
--
-- A subscribed day is any UTC day touched by a paid, unrevoked period. Grace
-- windows keep perks on but credit nothing until the store renews the period.
-- One accrual row per (account, day) makes double credit impossible even with
-- subscriptions on several platforms.

CREATE TABLE IF NOT EXISTS premium_subscriptions (
  subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('apple', 'google', 'web')),
  -- Apple originalTransactionId, Google purchase token, provider subscription id.
  original_transaction_id text NOT NULL CHECK (length(original_transaction_id) BETWEEN 1 AND 4096),
  sku text NOT NULL REFERENCES premium_products(sku) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  status text NOT NULL CHECK (status IN ('active', 'grace', 'on_hold', 'paused', 'expired', 'revoked')),
  current_period_end timestamptz NOT NULL,
  grace_until timestamptz NULL,
  auto_renew boolean NULL,
  latest_transaction_id text NULL,
  anonymized_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premium_subscriptions_original_unique UNIQUE (platform, original_transaction_id),
  CONSTRAINT premium_subscriptions_owner_shape CHECK (account_id IS NOT NULL OR anonymized_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS premium_subscriptions_account_idx
  ON premium_subscriptions (account_id, status);

DROP TRIGGER IF EXISTS premium_subscriptions_set_updated_at ON premium_subscriptions;
CREATE TRIGGER premium_subscriptions_set_updated_at
BEFORE UPDATE ON premium_subscriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per paid period (initial buy or renewal). Refunds revoke a period.
CREATE TABLE IF NOT EXISTS premium_subscription_periods (
  period_id bigserial PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES premium_subscriptions(subscription_id) ON DELETE RESTRICT,
  purchase_id uuid NOT NULL UNIQUE REFERENCES premium_purchases(purchase_id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premium_subscription_periods_range CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS premium_subscription_periods_subscription_idx
  ON premium_subscription_periods (subscription_id, starts_at);

CREATE TABLE IF NOT EXISTS premium_pass_first_grants (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES premium_subscriptions(subscription_id) ON DELETE RESTRICT,
  player_id text NOT NULL,
  lumen bigint NOT NULL CHECK (lumen > 0),
  inventory_operation_key text NOT NULL UNIQUE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  clawed_back_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS premium_pass_accruals (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  day date NOT NULL,
  period_id bigint NOT NULL REFERENCES premium_subscription_periods(period_id) ON DELETE RESTRICT,
  player_id text NOT NULL,
  lumen bigint NOT NULL CHECK (lumen > 0),
  inventory_operation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  clawed_back_at timestamptz NULL,
  PRIMARY KEY (account_id, day)
);

CREATE INDEX IF NOT EXISTS premium_pass_accruals_period_idx
  ON premium_pass_accruals (period_id);

-- Zero free minting: Lumen enters inventory only from the audited admin grant,
-- the 0917 migration, a paid Atlas Pass accrual, or a move of existing custody.
CREATE OR REPLACE FUNCTION enforce_lumen_inventory_provenance()
RETURNS trigger AS $$
BEGIN
  IF NEW.delta_quantity > 0 AND NEW.source NOT IN (
    'lumen_admin_grant', 'lumen_wallet_migration', 'atlas_pass_lumen_grant',
    'market_trade_purchase', 'market_manual_cancellation',
    'market_collection_claim', 'market_collection_repair',
    'pickup_dropped_item', 'manor_stack_withdrawal', 'manor_bulk_take'
  ) THEN
    RAISE EXCEPTION 'Lumen cannot enter inventory from source %', NEW.source;
  END IF;
  -- A pass credit must be backed by its first-grant or accrual rows.
  IF NEW.delta_quantity > 0 AND NEW.source = 'atlas_pass_lumen_grant' AND NOT (
    EXISTS (
      SELECT 1 FROM premium_pass_first_grants grant_row
      WHERE grant_row.inventory_operation_key = NEW.operation_key
        AND grant_row.player_id = NEW.player_id
        AND grant_row.lumen = NEW.delta_quantity
    )
    OR NEW.delta_quantity = (
      SELECT sum(accrual.lumen) FROM premium_pass_accruals accrual
      WHERE accrual.inventory_operation_key = NEW.operation_key
        AND accrual.player_id = NEW.player_id
    )
  ) THEN
    RAISE EXCEPTION 'Atlas Pass Lumen credit has no matching paid accrual';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
