ALTER TABLE pet_expedition_debug_operations
  DROP CONSTRAINT pet_expedition_debug_operations_action_check;

UPDATE pet_expedition_debug_operations
SET action = 'clear_unfinished'
WHERE action = 'clear_active';

ALTER TABLE pet_expedition_debug_operations
  ADD CONSTRAINT pet_expedition_debug_operations_action_check
  CHECK (action IN (
    'complete_now', 'force_safe', 'force_minor_injury', 'force_major_injury',
    'force_no_materials', 'force_rare_lore', 'grant_xp', 'set_level',
    'clear_unfinished', 'heal', 'clear_fatigue', 'reset_expedition_progress'
  ));
