-- Premium currencies foundation: Glimmer and Lumen.
--
-- Balances are account-scoped: purchases and memberships bind to the account
-- (Apple ID / Google account / web customer), and players_account_id_unique_idx
-- (0010) already limits an account to one player. Every table is keyed by a
-- `currency` column so further currencies are rows, not tables.
--
-- Hard product rule: there are no free sources. The only credit reason this
-- migration admits is `admin` (developer/admin grants, audited); later
-- purchase and membership paths must extend the reason check in their own
-- forward migration.

CREATE TABLE IF NOT EXISTS premium_currencies (
  currency text PRIMARY KEY CHECK (currency ~ '^[a-z][a-z0-9_]{0,31}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO premium_currencies (currency, display_name)
VALUES ('glimmer', 'Glimmer'), ('lumen', 'Lumen')
ON CONFLICT (currency) DO NOTHING;

CREATE TABLE IF NOT EXISTS premium_wallets (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  currency text NOT NULL REFERENCES premium_currencies(currency) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, currency)
);

DROP TRIGGER IF EXISTS premium_wallets_set_updated_at ON premium_wallets;
CREATE TRIGGER premium_wallets_set_updated_at
BEFORE UPDATE ON premium_wallets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS premium_wallet_events (
  event_id bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  currency text NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 240),
  delta bigint NOT NULL CHECK (delta <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  version_after bigint NOT NULL CHECK (version_after > 0),
  reason text NOT NULL CHECK (reason IN ('admin', 'spend')),
  actor_player_id text NULL,
  ref_type text NULL CHECK (ref_type IS NULL OR length(ref_type) BETWEEN 1 AND 80),
  ref_id text NULL CHECK (ref_id IS NULL OR length(ref_id) BETWEEN 1 AND 240),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(metadata::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT premium_wallet_events_operation_unique UNIQUE (account_id, operation_key),
  CONSTRAINT premium_wallet_events_version_unique UNIQUE (account_id, currency, version_after),
  CONSTRAINT premium_wallet_events_wallet_fk
    FOREIGN KEY (account_id, currency)
    REFERENCES premium_wallets(account_id, currency) ON DELETE RESTRICT,
  CONSTRAINT premium_wallet_events_actor_fk
    FOREIGN KEY (actor_player_id, account_id)
    REFERENCES players(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT premium_wallet_events_ref_shape
    CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  -- Spending can only remove currency; only audited admin events may add it.
  CONSTRAINT premium_wallet_events_spend_is_debit
    CHECK (reason <> 'spend' OR delta < 0)
);

CREATE INDEX IF NOT EXISTS premium_wallet_events_chain_idx
  ON premium_wallet_events (account_id, currency, version_after);
CREATE INDEX IF NOT EXISTS premium_wallet_events_created_idx
  ON premium_wallet_events (created_at DESC, event_id);

DROP TRIGGER IF EXISTS premium_wallet_events_immutable ON premium_wallet_events;
CREATE TRIGGER premium_wallet_events_immutable
BEFORE UPDATE OR DELETE ON premium_wallet_events
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION reject_premium_wallet_identity_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'premium wallets cannot be deleted';
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'premium wallet identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS premium_wallets_identity_guard ON premium_wallets;
CREATE TRIGGER premium_wallets_identity_guard
BEFORE UPDATE OR DELETE ON premium_wallets
FOR EACH ROW EXECUTE FUNCTION reject_premium_wallet_identity_mutation();

CREATE OR REPLACE FUNCTION validate_premium_wallet_event_chain(
  target_account_id uuid,
  target_currency text
)
RETURNS void AS $$
DECLARE
  target_wallet premium_wallets%ROWTYPE;
  event_count bigint;
  event_total numeric;
  latest_balance bigint;
  latest_version bigint;
BEGIN
  SELECT * INTO target_wallet
  FROM premium_wallets
  WHERE account_id = target_account_id AND currency = target_currency;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'premium wallet event chain has no authoritative wallet';
  END IF;

  SELECT count(*), coalesce(sum(delta), 0),
         coalesce(max(version_after), 0),
         (array_agg(balance_after ORDER BY version_after DESC))[1]
  INTO event_count, event_total, latest_version, latest_balance
  FROM premium_wallet_events
  WHERE account_id = target_account_id AND currency = target_currency;

  IF event_count <> target_wallet.version OR latest_version <> target_wallet.version THEN
    RAISE EXCEPTION 'premium wallet version does not match exactly one event per transition';
  END IF;
  IF target_wallet.version = 0 THEN
    IF target_wallet.balance <> 0 THEN
      RAISE EXCEPTION 'version-zero premium wallet must have zero balance and no events';
    END IF;
    RETURN;
  END IF;
  IF event_total <> target_wallet.balance
     OR latest_balance <> target_wallet.balance THEN
    RAISE EXCEPTION 'premium wallet balance does not match its durable event chain';
  END IF;
  IF EXISTS (
    WITH ordered AS (
      SELECT version_after, delta, balance_after,
             lag(balance_after, 1, 0::bigint) OVER (ORDER BY version_after) AS previous_balance,
             row_number() OVER (ORDER BY version_after) AS expected_version
      FROM premium_wallet_events
      WHERE account_id = target_account_id AND currency = target_currency
    )
    SELECT 1 FROM ordered
    WHERE version_after <> expected_version
       OR balance_after <> previous_balance + delta
  ) THEN
    RAISE EXCEPTION 'premium wallet event chain contains an invalid transition';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_premium_wallet_chain_commit()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_premium_wallet_event_chain(NEW.account_id, NEW.currency);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS premium_wallets_event_chain_guard ON premium_wallets;
CREATE CONSTRAINT TRIGGER premium_wallets_event_chain_guard
AFTER INSERT OR UPDATE ON premium_wallets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_premium_wallet_chain_commit();
DROP TRIGGER IF EXISTS premium_wallet_events_chain_guard ON premium_wallet_events;
CREATE CONSTRAINT TRIGGER premium_wallet_events_chain_guard
AFTER INSERT ON premium_wallet_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_premium_wallet_chain_commit();

-- Economy Observatory projection: asset identity `currency:<currency>`.
-- Admin grants and admin corrections are ADMIN; spends are SINK.
CREATE OR REPLACE FUNCTION record_premium_wallet_economy_event()
RETURNS trigger AS $$
BEGIN
  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, variant,
    quantity, custody_type, custody_id, player_id, source_system, source_id,
    source_operation_key, reason, metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta > 0 THEN 'credit' ELSE 'debit' END,
    CASE WHEN NEW.reason = 'spend' THEN 'SINK' ELSE 'ADMIN' END,
    'fungible', 'currency:' || NEW.currency, 'default',
    abs(NEW.delta), 'player_wallet', NEW.account_id::text, NEW.actor_player_id,
    'premium_wallet_events', NEW.event_id::text, NEW.operation_key, NEW.reason,
    NEW.metadata, NEW.created_at, 'premium_wallet'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS premium_wallet_events_economy_observatory ON premium_wallet_events;
CREATE TRIGGER premium_wallet_events_economy_observatory
AFTER INSERT ON premium_wallet_events
FOR EACH ROW EXECUTE FUNCTION record_premium_wallet_economy_event();
