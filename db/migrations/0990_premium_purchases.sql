-- Real-money purchases: catalog, per-account store token, purchase ledger and
-- the two new premium-wallet reasons (premium-currency-plan.md §5.1, §6.2–§6.8).
--
-- Every purchase path ships disabled (PURCHASES_*_ENABLED=false). Zero free
-- minting still holds: a `purchase` credit must equal exactly one granted
-- premium_purchases row of the same account, and `refund_clawback` must be the
-- debit recorded on exactly one refunded purchase. Clawback may drive the
-- Glimmer balance negative (arrears, §6.7); every other debit still needs funds.

-- ---------------------------------------------------------------------------
-- Catalog (identical ladder on iOS, Android and web; plan §5.1, §5.2).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS premium_products (
  sku text PRIMARY KEY CHECK (sku ~ '^[a-z][a-z0-9_]{1,63}$'),
  kind text NOT NULL CHECK (kind IN ('glimmer_pack', 'atlas_pass')),
  glimmer_amount bigint NOT NULL CHECK (glimmer_amount >= 0),
  first_purchase_bonus_glimmer bigint NOT NULL DEFAULT 0 CHECK (first_purchase_bonus_glimmer >= 0),
  usd_cents integer NOT NULL CHECK (usd_cents > 0),
  period text NULL CHECK (period IS NULL OR period IN ('month', 'year')),
  apple_product_id text NOT NULL UNIQUE CHECK (apple_product_id ~ '^[a-z0-9._]{1,150}$'),
  google_product_id text NOT NULL UNIQUE CHECK (google_product_id ~ '^[a-z0-9._]{1,150}$'),
  web_sku text NOT NULL UNIQUE CHECK (web_sku ~ '^[a-z0-9_]{1,64}$'),
  sort_order integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premium_products_kind_shape CHECK (
    (kind = 'glimmer_pack' AND glimmer_amount > 0 AND period IS NULL)
    OR (kind = 'atlas_pass' AND glimmer_amount = 0
        AND first_purchase_bonus_glimmer = 0 AND period IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS premium_products_set_updated_at ON premium_products;
CREATE TRIGGER premium_products_set_updated_at
BEFORE UPDATE ON premium_products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- First-purchase bonus: double Glimmer on the first pack up to Pouch, once per account.
INSERT INTO premium_products (
  sku, kind, glimmer_amount, first_purchase_bonus_glimmer, usd_cents, period,
  apple_product_id, google_product_id, web_sku, sort_order
) VALUES
  ('glimmer_pinch', 'glimmer_pack', 200, 200, 199, NULL,
   'com.ashatlas.game.glimmer.pinch', 'com.ashatlas.game.glimmer.pinch', 'glimmer_pinch', 10),
  ('glimmer_handful', 'glimmer_pack', 550, 550, 499, NULL,
   'com.ashatlas.game.glimmer.handful', 'com.ashatlas.game.glimmer.handful', 'glimmer_handful', 20),
  ('glimmer_pouch', 'glimmer_pack', 1150, 1150, 999, NULL,
   'com.ashatlas.game.glimmer.pouch', 'com.ashatlas.game.glimmer.pouch', 'glimmer_pouch', 30),
  ('glimmer_satchel', 'glimmer_pack', 2400, 0, 1999, NULL,
   'com.ashatlas.game.glimmer.satchel', 'com.ashatlas.game.glimmer.satchel', 'glimmer_satchel', 40),
  ('glimmer_chest', 'glimmer_pack', 6250, 0, 4999, NULL,
   'com.ashatlas.game.glimmer.chest', 'com.ashatlas.game.glimmer.chest', 'glimmer_chest', 50),
  ('glimmer_hoard', 'glimmer_pack', 13000, 0, 9999, NULL,
   'com.ashatlas.game.glimmer.hoard', 'com.ashatlas.game.glimmer.hoard', 'glimmer_hoard', 60),
  ('atlas_pass_monthly', 'atlas_pass', 0, 0, 999, 'month',
   'com.ashatlas.game.pass.monthly', 'com.ashatlas.game.pass.monthly', 'atlas_pass_monthly', 100),
  ('atlas_pass_yearly', 'atlas_pass', 0, 0, 9999, 'year',
   'com.ashatlas.game.pass.yearly', 'com.ashatlas.game.pass.yearly', 'atlas_pass_yearly', 110)
ON CONFLICT (sku) DO NOTHING;

-- ---------------------------------------------------------------------------
-- appAccountToken: one UUID per account. iOS sends it as StoreKit
-- appAccountToken, Android as the obfuscated external account id.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS premium_account_store_tokens (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  app_account_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Purchase ledger and state machine (plan §6.3):
--   pending_store -> verified | granted | rejected
--   verified      -> granted | rejected
--   granted       -> refunded_clawed_back | refunded_in_arrears
-- Rows are never deleted. Account deletion anonymizes them (account_id NULL,
-- token and price detail removed) so tax and refund records survive.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS premium_purchases (
  purchase_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('apple', 'google', 'web')),
  platform_transaction_id text NOT NULL CHECK (length(platform_transaction_id) BETWEEN 1 AND 240),
  original_transaction_id text NULL CHECK (original_transaction_id IS NULL OR length(original_transaction_id) BETWEEN 1 AND 240),
  purchase_token text NULL CHECK (purchase_token IS NULL OR length(purchase_token) BETWEEN 1 AND 4096),
  sku text NOT NULL REFERENCES premium_products(sku) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  state text NOT NULL CHECK (state IN (
    'pending_store', 'verified', 'granted', 'rejected',
    'refunded_clawed_back', 'refunded_in_arrears'
  )),
  glimmer_amount bigint NOT NULL DEFAULT 0 CHECK (glimmer_amount >= 0),
  bonus_glimmer bigint NOT NULL DEFAULT 0 CHECK (bonus_glimmer >= 0),
  first_purchase_bonus boolean NOT NULL DEFAULT false,
  usd_cents integer NOT NULL CHECK (usd_cents > 0),
  -- Store price in thousandths of price_currency (Apple milliunits); NULL when unknown.
  store_price_milli bigint NULL CHECK (store_price_milli IS NULL OR store_price_milli >= 0),
  price_currency text NULL CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'),
  app_account_token uuid NULL,
  purchased_at timestamptz NOT NULL,
  granted_at timestamptz NULL,
  granted_event_id bigint NULL,
  store_acknowledged_at timestamptz NULL,
  rejection_reason text NULL CHECK (rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 80),
  refunded_at timestamptz NULL,
  refund_reason text NULL CHECK (refund_reason IS NULL OR length(refund_reason) BETWEEN 1 AND 80),
  clawback_event_id bigint NULL,
  clawback_glimmer bigint NULL CHECK (clawback_glimmer IS NULL OR clawback_glimmer >= 0),
  lumen_clawback_owed bigint NULL CHECK (lumen_clawback_owed IS NULL OR lumen_clawback_owed >= 0),
  lumen_clawback_recovered bigint NULL CHECK (lumen_clawback_recovered IS NULL OR lumen_clawback_recovered >= 0),
  risk_flags text[] NOT NULL DEFAULT '{}'::text[],
  anonymized_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premium_purchases_transaction_unique UNIQUE (platform, platform_transaction_id),
  CONSTRAINT premium_purchases_owner_shape CHECK (account_id IS NOT NULL OR anonymized_at IS NOT NULL),
  CONSTRAINT premium_purchases_grant_shape CHECK (
    state NOT IN ('granted', 'refunded_clawed_back', 'refunded_in_arrears') OR granted_at IS NOT NULL
  ),
  CONSTRAINT premium_purchases_refund_shape CHECK (
    (state IN ('refunded_clawed_back', 'refunded_in_arrears')) = (refunded_at IS NOT NULL)
  ),
  CONSTRAINT premium_purchases_bonus_shape CHECK (first_purchase_bonus = (bonus_glimmer > 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS premium_purchases_first_bonus_once_idx
  ON premium_purchases (account_id) WHERE first_purchase_bonus;
CREATE INDEX IF NOT EXISTS premium_purchases_account_time_idx
  ON premium_purchases (account_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS premium_purchases_token_idx
  ON premium_purchases (platform, purchase_token) WHERE purchase_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS premium_purchases_unacknowledged_idx
  ON premium_purchases (platform, created_at)
  WHERE state = 'granted' AND store_acknowledged_at IS NULL;

DROP TRIGGER IF EXISTS premium_purchases_set_updated_at ON premium_purchases;
CREATE TRIGGER premium_purchases_set_updated_at
BEFORE UPDATE ON premium_purchases
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION guard_premium_purchase_transition()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'premium purchases cannot be deleted';
  END IF;
  IF NEW.purchase_id IS DISTINCT FROM OLD.purchase_id
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.platform_transaction_id IS DISTINCT FROM OLD.platform_transaction_id
     OR NEW.sku IS DISTINCT FROM OLD.sku
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.purchased_at IS DISTINCT FROM OLD.purchased_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'premium purchase identity is immutable';
  END IF;
  -- Only anonymization may clear the owner; nothing may move a purchase.
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     AND NOT (NEW.account_id IS NULL AND NEW.anonymized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'premium purchase owner is immutable';
  END IF;
  IF OLD.state IN ('granted', 'refunded_clawed_back', 'refunded_in_arrears')
     AND (NEW.glimmer_amount IS DISTINCT FROM OLD.glimmer_amount
          OR NEW.bonus_glimmer IS DISTINCT FROM OLD.bonus_glimmer
          OR NEW.first_purchase_bonus IS DISTINCT FROM OLD.first_purchase_bonus
          OR NEW.granted_event_id IS DISTINCT FROM OLD.granted_event_id
          OR NEW.granted_at IS DISTINCT FROM OLD.granted_at) THEN
    RAISE EXCEPTION 'granted premium purchase amounts are immutable';
  END IF;
  IF OLD.state IN ('refunded_clawed_back', 'refunded_in_arrears')
     AND (NEW.clawback_event_id IS DISTINCT FROM OLD.clawback_event_id
          OR NEW.clawback_glimmer IS DISTINCT FROM OLD.clawback_glimmer
          OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at) THEN
    RAISE EXCEPTION 'premium purchase refund is immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'pending_store' AND NEW.state IN ('verified', 'granted', 'rejected'))
    OR (OLD.state = 'verified' AND NEW.state IN ('granted', 'rejected'))
    OR (OLD.state = 'granted' AND NEW.state IN ('refunded_clawed_back', 'refunded_in_arrears'))
  ) THEN
    RAISE EXCEPTION 'premium purchase cannot move from % to %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS premium_purchases_transition_guard ON premium_purchases;
CREATE TRIGGER premium_purchases_transition_guard
BEFORE UPDATE OR DELETE ON premium_purchases
FOR EACH ROW EXECUTE FUNCTION guard_premium_purchase_transition();

-- ---------------------------------------------------------------------------
-- Premium wallet: `purchase` credits and `refund_clawback` debits. Arrears are
-- allowed only through a clawback; credits may leave a wallet still negative.
-- ---------------------------------------------------------------------------

ALTER TABLE premium_wallets DROP CONSTRAINT IF EXISTS premium_wallets_balance_check;
ALTER TABLE premium_wallet_events DROP CONSTRAINT IF EXISTS premium_wallet_events_balance_after_check;
ALTER TABLE premium_wallet_events
  DROP CONSTRAINT IF EXISTS premium_wallet_events_arrears_shape;
ALTER TABLE premium_wallet_events
  ADD CONSTRAINT premium_wallet_events_arrears_shape
  CHECK (balance_after >= 0 OR delta > 0 OR reason = 'refund_clawback');

ALTER TABLE premium_wallet_events
  DROP CONSTRAINT IF EXISTS premium_wallet_events_reason_check;
ALTER TABLE premium_wallet_events
  ADD CONSTRAINT premium_wallet_events_reason_check
  CHECK (reason IN ('admin', 'spend', 'market', 'inventory_migration', 'purchase', 'refund_clawback'));
ALTER TABLE premium_wallet_events
  DROP CONSTRAINT IF EXISTS premium_wallet_events_purchase_shape;
ALTER TABLE premium_wallet_events
  ADD CONSTRAINT premium_wallet_events_purchase_shape
  CHECK (
    reason NOT IN ('purchase', 'refund_clawback')
    OR (
      currency = 'glimmer'
      AND ref_type = 'premium_purchase'
      AND ref_id IS NOT NULL
      AND ((reason = 'purchase' AND delta > 0) OR (reason = 'refund_clawback' AND delta < 0))
    )
  );

-- At commit, a purchase credit is exactly the granted amount of one purchase
-- of this account, and a clawback is exactly that purchase's recorded clawback.
CREATE OR REPLACE FUNCTION enforce_premium_purchase_wallet_event()
RETURNS trigger AS $$
DECLARE
  purchase premium_purchases%ROWTYPE;
BEGIN
  SELECT * INTO purchase FROM premium_purchases
  WHERE purchase_id::text = NEW.ref_id;
  IF NOT FOUND OR purchase.account_id IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'premium wallet % event has no purchase of this account', NEW.reason;
  END IF;
  IF NEW.reason = 'purchase' THEN
    IF purchase.state NOT IN ('granted', 'refunded_clawed_back', 'refunded_in_arrears')
       OR purchase.granted_event_id IS DISTINCT FROM NEW.event_id
       OR purchase.glimmer_amount + purchase.bonus_glimmer <> NEW.delta THEN
      RAISE EXCEPTION 'premium purchase credit does not match its granted purchase';
    END IF;
  ELSE
    IF purchase.state NOT IN ('refunded_clawed_back', 'refunded_in_arrears')
       OR purchase.clawback_event_id IS DISTINCT FROM NEW.event_id
       OR purchase.clawback_glimmer IS DISTINCT FROM -NEW.delta
       OR -NEW.delta > purchase.glimmer_amount + purchase.bonus_glimmer THEN
      RAISE EXCEPTION 'premium refund clawback does not match its refunded purchase';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS premium_wallet_events_purchase_guard ON premium_wallet_events;
CREATE CONSTRAINT TRIGGER premium_wallet_events_purchase_guard
AFTER INSERT ON premium_wallet_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.reason IN ('purchase', 'refund_clawback'))
EXECUTE FUNCTION enforce_premium_purchase_wallet_event();

-- Observatory: purchases are SOURCE, clawbacks ADMIN (plan §6.10).
CREATE OR REPLACE FUNCTION record_premium_wallet_economy_event()
RETURNS trigger AS $$
BEGIN
  IF NEW.reason = 'market' THEN
    RETURN NEW;
  END IF;
  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, variant,
    quantity, custody_type, custody_id, player_id, source_system, source_id,
    source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta > 0 THEN 'credit' ELSE 'debit' END,
    CASE
      WHEN NEW.reason = 'spend' THEN 'SINK'
      WHEN NEW.reason = 'purchase' THEN 'SOURCE'
      ELSE 'ADMIN'
    END,
    'fungible', 'currency:' || NEW.currency, 'default',
    abs(NEW.delta), 'player_wallet', NEW.account_id::text, NEW.actor_player_id,
    'premium_wallet_events', NEW.event_id::text, NEW.operation_key, NEW.reason,
    NEW.metadata, NEW.created_at, 'premium_wallet'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
