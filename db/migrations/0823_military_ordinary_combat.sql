-- Extend the durable military operation ledger for owner-commanded ordinary hits.
-- This forward migration preserves all prior rows while making attack requests replayable.
ALTER TABLE military_unit_operations
  DROP CONSTRAINT IF EXISTS military_unit_operations_action_check;

ALTER TABLE military_unit_operations
  ADD CONSTRAINT military_unit_operations_action_check CHECK (action IN (
    'combine','split','load_bombers','build_war_camp','call_troops',
    'relocate_war_camp','remove_war_camp','follow','deploy','return','stop',
    'repair_ballista','attack'
  ));
