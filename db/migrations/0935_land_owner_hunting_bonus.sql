-- Land owner hunting bonus: when a player kills a monster on someone else's
-- flag territory, the land owner is paid 4% of that kill's gold, newly
-- minted (never taken from the hunter). Personal flags pay the owner's
-- wallet (wallet_events), city flags pay the City Gold Reserve
-- (city_gold_ledger, 'land_bonus'), kingdom flags pay the Kingdom Gold
-- Reserve (kingdom_gold_ledger, new here: the kingdom treasury only held
-- items). Every payout is keyed by the combat settlement, so a replayed
-- settlement can never pay twice.

-- City Gold Reserve: a minted credit is neither a donation nor a refund.
ALTER TABLE city_gold_reserves
  ADD COLUMN IF NOT EXISTS lifetime_land_bonus bigint NOT NULL DEFAULT 0
    CHECK (lifetime_land_bonus >= 0);

ALTER TABLE city_gold_reserves
  DROP CONSTRAINT IF EXISTS city_gold_reserves_check,
  DROP CONSTRAINT IF EXISTS city_gold_reserves_balance_reconciles;
ALTER TABLE city_gold_reserves
  ADD CONSTRAINT city_gold_reserves_balance_reconciles
  CHECK (lifetime_donated + lifetime_land_bonus >= balance + lifetime_spent);

ALTER TABLE city_gold_operations
  DROP CONSTRAINT IF EXISTS city_gold_operations_action_check;
ALTER TABLE city_gold_operations
  ADD CONSTRAINT city_gold_operations_action_check
  CHECK (action IN ('donate', 'construction_spend', 'construction_refund', 'land_bonus'));

ALTER TABLE city_gold_ledger
  DROP CONSTRAINT IF EXISTS city_gold_ledger_entry_type_check;
ALTER TABLE city_gold_ledger
  ADD CONSTRAINT city_gold_ledger_entry_type_check
  CHECK (entry_type IN ('member_donation', 'construction_spend', 'construction_refund', 'land_bonus'));

-- Kingdom Gold Reserve: Gold the kingdom earns from hunting on its land.
CREATE TABLE IF NOT EXISTS kingdom_gold_reserves (
  kingdom_id uuid PRIMARY KEY REFERENCES kingdoms(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned bigint NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lifetime_earned >= balance)
);

CREATE TABLE IF NOT EXISTS kingdom_gold_ledger (
  entry_id bigserial PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('land_bonus')),
  delta bigint NOT NULL CHECK (delta <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  source_type text NOT NULL,
  source_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(metadata::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS kingdom_gold_ledger_kingdom_created_idx
  ON kingdom_gold_ledger (kingdom_id, created_at DESC, entry_id);

DROP TRIGGER IF EXISTS kingdom_gold_ledger_immutable ON kingdom_gold_ledger;
CREATE TRIGGER kingdom_gold_ledger_immutable
BEFORE UPDATE OR DELETE ON kingdom_gold_ledger
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();

-- One land-bonus decision per combat settlement, whichever payee (or none)
-- it resolved to. A replay finds this row and pays nothing more.
CREATE TABLE IF NOT EXISTS land_owner_bonus_payouts (
  settlement_key text PRIMARY KEY,
  hunter_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  payee_kind text NOT NULL CHECK (payee_kind IN ('player', 'city', 'kingdom')),
  payee_id text NOT NULL,
  flag_id uuid NULL,
  kill_gold bigint NOT NULL CHECK (kill_gold > 0),
  bonus_gold bigint NOT NULL CHECK (bonus_gold > 0),
  paid_gold bigint NOT NULL CHECK (paid_gold >= 0 AND paid_gold <= bonus_gold),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS land_owner_bonus_payouts_payee_idx
  ON land_owner_bonus_payouts (payee_kind, payee_id, created_at DESC);

DROP TRIGGER IF EXISTS land_owner_bonus_payouts_immutable ON land_owner_bonus_payouts;
CREATE TRIGGER land_owner_bonus_payouts_immutable
BEFORE UPDATE OR DELETE ON land_owner_bonus_payouts
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();

COMMENT ON TABLE land_owner_bonus_payouts IS
  'One row per combat settlement that paid a land owner hunting bonus (4% of the kill gold, minted). paid_gold < bonus_gold only when a City Gold Reserve capacity clamp applied.';
