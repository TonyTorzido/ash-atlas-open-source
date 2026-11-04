ALTER TABLE player_class_unlocks
  DROP CONSTRAINT IF EXISTS player_class_unlocks_check,
  DROP CONSTRAINT IF EXISTS player_class_unlocks_gold_paid_check;

ALTER TABLE player_class_unlocks
  ADD CONSTRAINT player_class_unlocks_gold_paid_check CHECK (
    (class_id = 'warrior' AND gold_paid = 0) OR
    (class_id = 'cleric' AND gold_paid IN (0, 50000)) OR
    (class_id NOT IN ('warrior', 'cleric') AND gold_paid = 50000)
  );

INSERT INTO player_class_unlocks (player_id, class_id, unlock_operation_key, gold_paid)
SELECT id, 'cleric', 'launch-default-cleric:' || id, 0
FROM players
ON CONFLICT (player_id, class_id) DO NOTHING;

COMMENT ON TABLE player_class_unlocks IS
  'Permanent authoritative launch-class entitlements; Warrior and Cleric are free defaults and other launch classes cost exactly 50,000 Gold.';
