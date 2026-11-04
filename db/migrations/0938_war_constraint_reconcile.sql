-- War for cities and kingdoms: constraint reconciliation.
--
-- Several war-release migrations redefine the same CHECK constraints, each
-- written on its own branch. This last migration re-creates every one of them
-- as the full union of the values any writer on the merged release uses plus
-- everything trunk already allowed, so no branch's later definition can drop
-- another's values.

-- Kingdom treasury ledger sources: Bricks economy (0922), surrender (0924),
-- war death (0925), kingdom perks (0929) and the Command Board (0930).
ALTER TABLE kingdom_treasury_ledger
  DROP CONSTRAINT IF EXISTS kingdom_treasury_ledger_source_valid;
ALTER TABLE kingdom_treasury_ledger
  ADD CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN (
      'brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package',
      'war_surrender_transfer', 'war_surrender_destroyed', 'war_death_loss',
      'kingdom_perk_choose', 'kingdom_perk_change',
      'command_board_upgrade', 'war_structure_build'
    )
  );

-- City Coin ledger entries: trunk's list, surrender (0924) and the City Market
-- daily package (0936).
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
    'war_surrender_destroyed',
    'market_daily_package'
  ));

-- City structure operations: trunk's list, Quartz Huts (0928) and building
-- warfare (0937).
ALTER TABLE city_structure_operations
  DROP CONSTRAINT IF EXISTS city_structure_operations_action_check;
ALTER TABLE city_structure_operations
  ADD CONSTRAINT city_structure_operations_action_check CHECK (
    action IN (
      'build_house', 'destroy_house', 'build_oil_well', 'destroy_oil_well',
      'build_quartz_hut', 'destroy_quartz_hut',
      'build_facility', 'upgrade_facility', 'destroy_facility',
      'claim_mayor', 'relinquish_mayor', 'expire_founder_grace',
      'build_market', 'build_monument', 'upgrade_monument', 'destroy_monument',
      'war_destroyed'
    )
  );

-- City structure tiers: Quartz Huts (0928) and City Market levels 1-10 (0933).
ALTER TABLE city_structures DROP CONSTRAINT IF EXISTS city_structures_tier_check;
ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_tier_check CHECK (
    tier BETWEEN 1 AND CASE WHEN structure_type = 'market' THEN 10 ELSE 3 END
  );
ALTER TABLE city_structures DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;
ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('oil_well', 'quartz_hut', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works') AND tier = 1)
    OR (structure_type = 'market' AND tier BETWEEN 1 AND 10)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'quartz_hut', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works', 'monument')
  );
