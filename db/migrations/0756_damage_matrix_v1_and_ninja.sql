-- Damage Matrix V1 equipment identities and five-class launch roster.
-- Druid, Knight, and Hunter rows remain durable historical data.

LOCK TABLE player_class_profiles, player_class_progress, player_class_loadouts,
  player_class_resources, player_class_unlocks, player_class_runtime,
  equipment_instances, combat_kits, combat_kit_items IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE player_class_profiles
  DROP CONSTRAINT IF EXISTS player_class_profiles_active_class_id_check;
ALTER TABLE player_class_profiles
  ADD CONSTRAINT player_class_profiles_active_class_id_check CHECK (
    active_class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja','hunter')
  ),
  ALTER COLUMN selected_subclasses SET DEFAULT
    '{"warrior":null,"druid":null,"ranger":null,"paladin":null,"knight":null,"cleric":null,"ninja":null,"hunter":null}'::jsonb;
UPDATE player_class_profiles
SET selected_subclasses = selected_subclasses || jsonb_build_object(
  'ninja', COALESCE(selected_subclasses->'ninja', 'null'::jsonb)
)
WHERE NOT (selected_subclasses ? 'ninja');

ALTER TABLE player_class_progress DROP CONSTRAINT IF EXISTS player_class_progress_class_id_check;
ALTER TABLE player_class_progress ADD CONSTRAINT player_class_progress_class_id_check CHECK (
  class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja','hunter')
);
ALTER TABLE player_class_loadouts DROP CONSTRAINT IF EXISTS player_class_loadouts_class_id_check;
ALTER TABLE player_class_loadouts ADD CONSTRAINT player_class_loadouts_class_id_check CHECK (
  class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja','hunter')
);
ALTER TABLE player_class_technique_unlocks DROP CONSTRAINT IF EXISTS player_class_technique_unlocks_class_id_check;
ALTER TABLE player_class_technique_unlocks ADD CONSTRAINT player_class_technique_unlocks_class_id_check CHECK (
  class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja','hunter')
);
ALTER TABLE class_progression_operations DROP CONSTRAINT IF EXISTS class_progression_operations_class_id_check;
ALTER TABLE class_progression_operations ADD CONSTRAINT class_progression_operations_class_id_check CHECK (
  class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja','hunter')
);
ALTER TABLE player_class_resources
  DROP CONSTRAINT IF EXISTS player_class_resources_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_resources_owner_check;
ALTER TABLE player_class_resources
  ADD CONSTRAINT player_class_resources_class_id_check CHECK (
    class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja','hunter')
  ),
  ADD CONSTRAINT player_class_resources_owner_check CHECK (
    (class_id = 'hunter' AND resource_id = 'focus') OR
    (class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja') AND resource_id = 'none')
  );
ALTER TABLE player_class_unlocks DROP CONSTRAINT IF EXISTS player_class_unlocks_class_id_check;
ALTER TABLE player_class_unlocks ADD CONSTRAINT player_class_unlocks_class_id_check CHECK (
  class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja')
);
ALTER TABLE player_class_progress DROP CONSTRAINT IF EXISTS player_class_progress_mastery_rank_v3_check;
ALTER TABLE player_class_progress ADD CONSTRAINT player_class_progress_mastery_rank_v3_check CHECK (
  (class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja') AND curve_version = 3
    AND mastery_rank BETWEEN 0 AND 15 AND mastery_xp BETWEEN 0 AND 72000)
  OR (class_id = 'hunter' AND curve_version = 1 AND mastery_rank BETWEEN 0 AND 25 AND mastery_xp >= 0)
);

ALTER TABLE dev_progression_operations DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
  'character_level','warrior_level','druid_level','ranger_level','hunter_level','paladin_level','knight_level','cleric_level','ninja_level',
  'woodcutter_level','miner_level','builder_level','hunter_profession_level','oil_worker_level',
  'warrior_mastery','reaver_mastery','warden_mastery'
));
ALTER TABLE combat_reward_participants DROP CONSTRAINT IF EXISTS combat_reward_participants_active_class_id_check;
ALTER TABLE combat_reward_participants ADD CONSTRAINT combat_reward_participants_active_class_id_check CHECK (
  active_class_id IS NULL OR active_class_id IN ('warrior','druid','ranger','paladin','knight','cleric','ninja','hunter')
);

ALTER TABLE player_mastery_achievements DROP CONSTRAINT IF EXISTS player_mastery_achievements_achievement_id_check;
ALTER TABLE player_mastery_achievements ADD CONSTRAINT player_mastery_achievements_achievement_id_check CHECK (
  achievement_id IN (
    'master_warrior','master_druid','master_ranger','master_paladin','master_knight','master_cleric','master_ninja',
    'master_woodcutter','master_miner','master_builder','master_hunter','master_oil_worker'
  )
);
ALTER TABLE player_mastery_state DROP CONSTRAINT IF EXISTS player_mastery_state_equipped_title_check;
ALTER TABLE player_mastery_state ADD CONSTRAINT player_mastery_state_equipped_title_check CHECK (
  equipped_title IS NULL OR equipped_title IN (
    'Master Warrior','Master Druid','Master Ranger','Master Paladin','Master Knight','Master Cleric','Master Ninja',
    'Master Woodcutter','Master Miner','Master Builder','Master Hunter','Master Oil Worker'
  )
);

INSERT INTO player_class_progress (
  player_id, class_id, mastery_xp, mastery_rank, curve_version,
  training_points_earned, training_points_spent
)
SELECT id, 'ninja', 0, 0, 3, 0, 0 FROM players
ON CONFLICT (player_id, class_id) DO NOTHING;
INSERT INTO player_class_loadouts (player_id, class_id)
SELECT id, 'ninja' FROM players ON CONFLICT (player_id, class_id) DO NOTHING;
INSERT INTO player_class_resources (player_id, class_id, resource_id, current_value)
SELECT id, 'ninja', 'none', 0 FROM players ON CONFLICT (player_id, class_id) DO NOTHING;

CREATE TEMP TABLE removed_class_fallback_players ON COMMIT DROP AS
SELECT player_id FROM player_class_profiles WHERE active_class_id IN ('druid','knight');

UPDATE player_class_profiles
SET active_class_id = 'warrior', active_subclass_id = NULL, revision = revision + 1
WHERE player_id IN (SELECT player_id FROM removed_class_fallback_players);
UPDATE player_class_runtime
SET queued_ability_id = NULL,
    queued_target_entity_id = NULL,
    queued_at_tick = NULL,
    rage_reserved = 0,
    status_effects = '[]'::jsonb,
    counters = '{}'::jsonb,
    combat_generation = combat_generation + 1,
    revision = revision + 1
WHERE player_id IN (SELECT player_id FROM removed_class_fallback_players);

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack, droppable, manor_storable,
  market_tradable, market_fungible, market_identity, supported_variants
) VALUES
  ('starter_shuriken','Starter Shuriken','equipment',false,1,true,true,false,false,NULL,ARRAY['default']::text[]),
  ('starter_wand','Starter Wand','equipment',false,1,true,true,false,false,NULL,ARRAY['default']::text[]),
  ('chain_armor','Chain Armor','equipment',false,1,true,true,false,false,NULL,ARRAY['default']::text[]),
  ('ranged_shield','Ranged Shield','equipment',false,1,true,true,false,false,NULL,ARRAY['default']::text[])
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  updated_at = now();

-- Staff is now the V1 blunt melee weapon. Preserve every owned instance while
-- reconciling active and saved secondary-slot references deterministically.
CREATE TEMP TABLE staff_secondary_owners ON COMMIT DROP AS
SELECT DISTINCT owner_player_id AS player_id
FROM equipment_instances
WHERE definition_id = 'starter_staff' AND location = 'equipped' AND equipped_slot = 'secondary';

UPDATE equipment_instances AS staff
SET location = 'inventory', equipped_slot = NULL
WHERE staff.definition_id = 'starter_staff'
  AND staff.location = 'equipped'
  AND staff.equipped_slot = 'secondary'
  AND EXISTS (
    SELECT 1 FROM equipment_instances AS melee
    WHERE melee.owner_player_id = staff.owner_player_id
      AND melee.location = 'equipped' AND melee.equipped_slot = 'melee'
  );
UPDATE equipment_instances
SET equipped_slot = 'melee'
WHERE definition_id = 'starter_staff' AND location = 'equipped' AND equipped_slot = 'secondary';
UPDATE player_equipment_state
SET readied_weapon_slot = 'melee',
    inventory_revision = inventory_revision + 1,
    active_revision = active_revision + 1,
    checkpoint_revision = checkpoint_revision + 1,
    active_kit_index = NULL
WHERE player_id IN (SELECT player_id FROM staff_secondary_owners);

CREATE TEMP TABLE staff_secondary_kits ON COMMIT DROP AS
SELECT DISTINCT kit.player_id, kit.kit_index
FROM combat_kit_items AS kit
JOIN equipment_instances AS equipment ON equipment.instance_id = kit.instance_id
WHERE equipment.definition_id = 'starter_staff' AND kit.equipment_slot = 'secondary';
DELETE FROM combat_kit_items AS staff
USING equipment_instances AS equipment
WHERE equipment.instance_id = staff.instance_id
  AND equipment.definition_id = 'starter_staff'
  AND staff.equipment_slot = 'secondary'
  AND EXISTS (
    SELECT 1 FROM combat_kit_items AS melee
    WHERE melee.player_id = staff.player_id
      AND melee.kit_index = staff.kit_index
      AND melee.equipment_slot = 'melee'
  );
UPDATE combat_kit_items AS staff
SET equipment_slot = 'melee'
FROM equipment_instances AS equipment
WHERE equipment.instance_id = staff.instance_id
  AND equipment.definition_id = 'starter_staff'
  AND staff.equipment_slot = 'secondary';
UPDATE combat_kits AS kit
SET readied_weapon_slot = 'melee', revision = revision + 1
WHERE (kit.player_id, kit.kit_index) IN (
  SELECT player_id, kit_index FROM staff_secondary_kits
);

COMMENT ON TABLE player_class_unlocks IS
  'Permanent authoritative class entitlements; Warrior and Cleric are free defaults, Ninja and other paid classes cost exactly 50,000 Gold, and removed-class rows remain historical.';
