ALTER TABLE city_coin_ledger
  DROP CONSTRAINT IF EXISTS city_coin_ledger_entry_type_check;
ALTER TABLE city_coin_ledger
  ADD CONSTRAINT city_coin_ledger_entry_type_check
  CHECK (entry_type IN (
    'combat_contribution',
    'development_grant',
    'package_grant',
    'construction_spend',
    'construction_refund'
  ));

ALTER TABLE city_gold_operations
  DROP CONSTRAINT IF EXISTS city_gold_operations_action_check;
ALTER TABLE city_gold_operations
  ADD CONSTRAINT city_gold_operations_action_check
  CHECK (action IN ('donate', 'construction_spend', 'construction_refund'));

ALTER TABLE city_gold_ledger
  DROP CONSTRAINT IF EXISTS city_gold_ledger_entry_type_check;
ALTER TABLE city_gold_ledger
  ADD CONSTRAINT city_gold_ledger_entry_type_check
  CHECK (entry_type IN ('member_donation', 'construction_spend', 'construction_refund'));
