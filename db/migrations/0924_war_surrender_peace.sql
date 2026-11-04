-- War for cities and kingdoms, part A3: surrender, mutual peace and the
-- 7-day forced peace.
--
-- A war ends by surrender (the loser's treasury loses 14% to the winner and
-- 12% destroyed;) or by a mutual peace (an offer from one
-- side, accepted by the other; no penalty). Either way a forced peace holds
-- between the pair until peace_until: no attacks on each other's structures
-- and no war declaration, automatic or from settings.

ALTER TABLE organization_wars
  ADD COLUMN IF NOT EXISTS peace_until timestamptz NULL;
ALTER TABLE organization_wars
  ADD COLUMN IF NOT EXISTS peace_offer_kind text NULL;
ALTER TABLE organization_wars
  ADD COLUMN IF NOT EXISTS peace_offer_id uuid NULL;
ALTER TABLE organization_wars
  ADD COLUMN IF NOT EXISTS peace_offered_by_player_id text NULL;
ALTER TABLE organization_wars
  ADD COLUMN IF NOT EXISTS peace_offered_at timestamptz NULL;

ALTER TABLE organization_wars DROP CONSTRAINT IF EXISTS organization_wars_peace_offered_by_fk;
ALTER TABLE organization_wars
  ADD CONSTRAINT organization_wars_peace_offered_by_fk
  FOREIGN KEY (peace_offered_by_player_id) REFERENCES players(id) ON DELETE SET NULL;

ALTER TABLE organization_wars DROP CONSTRAINT IF EXISTS organization_wars_ended_reason_valid;
ALTER TABLE organization_wars
  ADD CONSTRAINT organization_wars_ended_reason_valid CHECK (
    (status = 'active' AND ended_reason IS NULL AND peace_until IS NULL)
    OR (status = 'ended' AND ended_reason IN ('surrender', 'mutual_peace') AND peace_until IS NOT NULL)
  );

ALTER TABLE organization_wars DROP CONSTRAINT IF EXISTS organization_wars_peace_offer_valid;
ALTER TABLE organization_wars
  ADD CONSTRAINT organization_wars_peace_offer_valid CHECK (
    (peace_offer_kind IS NULL AND peace_offer_id IS NULL AND peace_offered_at IS NULL)
    OR (
      status = 'active'
      AND peace_offered_at IS NOT NULL
      AND (
        (peace_offer_kind = side_a_kind AND peace_offer_id = side_a_id)
        OR (peace_offer_kind = side_b_kind AND peace_offer_id = side_b_id)
      )
    )
  );

-- Forced-peace probe for a pair (attacks, auto-declare, settings declare).
CREATE INDEX IF NOT EXISTS organization_wars_peace_pair_idx
  ON organization_wars (side_a_kind, side_a_id, side_b_kind, side_b_id, peace_until DESC)
  WHERE peace_until IS NOT NULL;

-- One settlement per surrendered war. The war row's active -> ended
-- transition (under its row lock) is the idempotency guard; the primary key
-- makes a second settlement impossible. currency is the loser's treasury
-- currency; transferred reached the winner, destroyed left the game
-- (including a transfer share the winner could not hold).
CREATE TABLE IF NOT EXISTS organization_war_surrenders (
  war_id uuid PRIMARY KEY REFERENCES organization_wars(war_id) ON DELETE RESTRICT,
  loser_kind text NOT NULL CHECK (loser_kind IN ('city', 'kingdom')),
  loser_id uuid NOT NULL,
  winner_kind text NOT NULL CHECK (winner_kind IN ('city', 'kingdom')),
  winner_id uuid NOT NULL,
  surrendered_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  currency text NOT NULL CHECK (currency IN ('bricks', 'city_coins')),
  balance_before bigint NOT NULL CHECK (balance_before >= 0),
  transferred bigint NOT NULL CHECK (transferred >= 0),
  destroyed bigint NOT NULL CHECK (destroyed >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_war_surrenders_currency_valid CHECK (
    (loser_kind = 'kingdom') = (currency = 'bricks')
  ),
  CONSTRAINT organization_war_surrenders_amounts_valid CHECK (
    transferred + destroyed <= balance_before
    AND (transferred = 0 OR loser_kind = winner_kind)
  )
);

DROP TRIGGER IF EXISTS organization_war_surrenders_append_only ON organization_war_surrenders;
CREATE TRIGGER organization_war_surrenders_append_only
BEFORE UPDATE OR DELETE ON organization_war_surrenders
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

-- Kingdom treasury: surrender transfer legs and the destroyed share.
ALTER TABLE kingdom_treasury_ledger
  DROP CONSTRAINT IF EXISTS kingdom_treasury_ledger_source_valid;
ALTER TABLE kingdom_treasury_ledger
  ADD CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN (
      'brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package',
      'war_surrender_transfer', 'war_surrender_destroyed'
    )
  );

-- City treasury: the same legs in City Coins. Every entry type any earlier
-- migration allowed stays allowed, including structure_repair from an early
-- revision of 0913 that some branch and test databases applied.
ALTER TABLE city_coin_ledger
  DROP CONSTRAINT IF EXISTS city_coin_ledger_entry_type_check;
ALTER TABLE city_coin_ledger
  ADD CONSTRAINT city_coin_ledger_entry_type_check
  CHECK (entry_type IN (
    'combat_contribution',
    'development_grant',
    'package_grant',
    'construction_spend',
    'construction_refund',
    'structure_repair',
    'war_surrender_transfer',
    'war_surrender_destroyed'
  ));

-- Every City Coin debit is a sink and every credit a source for the economy
-- observatory (a debit leg must never be classified as a source). Same
-- result as before for every existing entry type.
CREATE OR REPLACE FUNCTION record_city_coin_economy_event()
RETURNS trigger AS $$
BEGIN
  INSERT INTO economy_events (
    event_group_id, leg, event_kind, asset_kind, asset_id, variant,
    quantity, custody_type, custody_id, player_id, organization_type,
    organization_id, source_system, source_id, source_operation_key, reason,
    metadata, occurred_at, coverage_domain
  ) VALUES (
    gen_random_uuid(),
    CASE WHEN NEW.delta > 0 THEN 'credit' ELSE 'debit' END,
    CASE WHEN NEW.delta < 0 THEN 'SINK' ELSE 'SOURCE' END,
    'fungible', 'city_coin', 'default', abs(NEW.delta), 'city_treasury',
    NEW.city_id::text, NEW.player_id, 'city', NEW.city_id::text,
    'city_coin_ledger', NEW.entry_id::text, NEW.operation_key, NEW.entry_type,
    coalesce(NEW.metadata, '{}'::jsonb), NEW.created_at, 'city_treasury'
  ) ON CONFLICT (source_system, source_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN organization_wars.peace_until IS
  'End of the forced peace that follows a surrender or mutual peace; NULL while the war is active.';
COMMENT ON TABLE organization_war_surrenders IS
  'Append-only surrender settlements: loser treasury balance, share transferred to the winner, share destroyed.';
