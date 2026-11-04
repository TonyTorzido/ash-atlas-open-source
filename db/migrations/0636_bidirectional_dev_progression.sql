-- Keep direct development adjustments in their dedicated replay ledger.
-- Production character, combat-class, and profession award ledgers remain monotonic.

ALTER TABLE dev_progression_operations
  DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;

ALTER TABLE dev_progression_operations
  ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
    'character_level',
    'warrior_mastery', 'reaver_mastery', 'warden_mastery',
    'warrior_level', 'hunter_level', 'paladin_level', 'cleric_level',
    'woodcutter_level', 'miner_level', 'builder_level', 'hunter_profession_level'
  ));
