ALTER TABLE player_class_unlocks
  DROP CONSTRAINT IF EXISTS player_class_unlocks_check,
  DROP CONSTRAINT IF EXISTS player_class_unlocks_gold_paid_check;

ALTER TABLE player_class_unlocks
  ADD CONSTRAINT player_class_unlocks_gold_paid_check CHECK (gold_paid IN (0, 50000));

COMMENT ON TABLE player_class_unlocks IS
  'Permanent authoritative class entitlements; new class unlocks are free, while gold_paid preserves the historical amount charged for existing entitlements.';
