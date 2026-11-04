-- Remove the Paladin and Cleric classes (owner decision, final).
--
-- Policy:
-- * Gold actually paid for a Paladin/Cleric unlock (player_class_unlocks.gold_paid)
--   is refunded through the authoritative wallet chain: one wallet_events row
--   per refunded unlock, keyed `class-removal-refund:<class>:<player>`, so the
--   refund lands exactly once. Free (0 Gold) unlocks refund nothing.
-- * Players whose active class is Paladin/Cleric switch to Warrior.
-- * Master Paladin / Master Cleric achievements are removed; an equipped title
--   falls back to the player's first remaining earned title, else none.
-- * Live class, subclass, specialization, runtime and operation rows for the
--   removed classes are deleted; skill points spent on removed specializations
--   return to the player's pool.
-- * combat_reward_participants keeps its reward history: completed rows drop
--   the removed class (NULL), and not-yet-completed settlements credit Warrior.
-- * The frozen one-time audits class_xp_curve_adjustments and
--   specialization_migration_audit keep their historical rows; their tightened
--   constraints are NOT VALID so new writes are rejected without rewriting the
--   audit trail.
--
-- Every statement is a no-op once the removed values are gone, so re-running
-- the file cannot refund twice or change surviving rows.

LOCK TABLE player_wallets, wallet_events, player_class_unlocks, player_class_profiles,
  player_class_progress, player_class_loadouts, player_class_technique_unlocks,
  player_class_resources, player_subclass_progress, player_subclass_loadouts,
  player_class_legacy_unlocks, class_progression_operations, dev_progression_operations,
  combat_reward_participants, player_mastery_achievements, player_mastery_state,
  player_profiles, player_skill_runtime, player_skill_point_state,
  player_specialization_ranks, player_specialization_state,
  player_specialization_ultimate_unlocks, specialization_ultimate_completion_identities,
  class_xp_curve_adjustments, specialization_migration_audit
  IN SHARE ROW EXCLUSIVE MODE;

-- 1. Refund Gold paid for removed-class unlocks through the wallet ledger.
DO $$
DECLARE
  refund record;
  wallet record;
  refund_key text;
BEGIN
  FOR refund IN
    SELECT unlock.player_id, unlock.class_id, unlock.unlock_operation_key, unlock.gold_paid
    FROM player_class_unlocks AS unlock
    WHERE unlock.class_id IN ('paladin', 'cleric') AND unlock.gold_paid > 0
    ORDER BY unlock.player_id, unlock.class_id
  LOOP
    refund_key := 'class-removal-refund:' || refund.class_id || ':' || refund.player_id;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM wallet_events
      WHERE operation_key = refund_key AND player_id = refund.player_id
    );

    INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
    SELECT players.id, players.account_id, 0, 0
    FROM players
    WHERE players.id = refund.player_id AND players.account_id IS NOT NULL
    ON CONFLICT (player_id) DO NOTHING;

    SELECT player_wallets.account_id, player_wallets.gold_balance, player_wallets.version
    INTO wallet
    FROM player_wallets
    WHERE player_wallets.player_id = refund.player_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'class removal refund for player % has no authoritative wallet', refund.player_id;
    END IF;

    UPDATE player_wallets
    SET gold_balance = wallet.gold_balance + refund.gold_paid,
        version = wallet.version + 1
    WHERE player_id = refund.player_id AND version = wallet.version;

    INSERT INTO wallet_events (
      operation_key, player_id, account_id, delta_gold, balance_after,
      version_after, reason, metadata
    ) VALUES (
      refund_key, refund.player_id, wallet.account_id, refund.gold_paid,
      wallet.gold_balance + refund.gold_paid, wallet.version + 1,
      'class_unlock_refund',
      jsonb_build_object(
        'migration', '0916',
        'classId', refund.class_id,
        'unlockOperationKey', refund.unlock_operation_key,
        'goldPaid', refund.gold_paid
      )
    );
  END LOOP;
END $$;

-- 2. Active class and subclass selection.
UPDATE player_class_profiles
SET active_class_id = CASE
      WHEN active_class_id IN ('paladin', 'cleric') THEN 'warrior'
      ELSE active_class_id
    END,
    active_subclass_id = CASE
      WHEN active_class_id IN ('paladin', 'cleric')
        OR active_subclass_id IN ('justicar', 'vindicator', 'hierophant', 'exorcist') THEN NULL
      ELSE active_subclass_id
    END,
    selected_subclasses = selected_subclasses - 'paladin' - 'cleric',
    revision = revision + 1
WHERE active_class_id IN ('paladin', 'cleric')
   OR active_subclass_id IN ('justicar', 'vindicator', 'hierophant', 'exorcist')
   OR selected_subclasses ?| ARRAY['paladin', 'cleric'];

ALTER TABLE player_class_profiles
  ALTER COLUMN selected_subclasses SET DEFAULT
    '{"warrior":null,"druid":null,"ranger":null,"knight":null,"ninja":null,"hunter":null}'::jsonb;

-- 3. Class-owned state for the removed classes.
DELETE FROM player_class_unlocks WHERE class_id IN ('paladin', 'cleric');
DELETE FROM player_class_progress WHERE class_id IN ('paladin', 'cleric');
DELETE FROM player_class_loadouts WHERE class_id IN ('paladin', 'cleric');
DELETE FROM player_class_technique_unlocks
WHERE class_id IN ('paladin', 'cleric')
   OR subclass_id IN ('justicar', 'vindicator', 'hierophant', 'exorcist');
DELETE FROM player_class_resources WHERE class_id IN ('paladin', 'cleric');
DELETE FROM player_subclass_progress
WHERE class_id IN ('paladin', 'cleric')
   OR subclass_id IN ('justicar', 'vindicator', 'hierophant', 'exorcist');
DELETE FROM player_subclass_loadouts
WHERE subclass_id IN ('justicar', 'vindicator', 'hierophant', 'exorcist');
DELETE FROM player_class_legacy_unlocks
WHERE completed_class_id IN ('paladin', 'cleric')
   OR legacy_id IN ('paladin_legacy_sacred_endurance', 'cleric_legacy_lasting_grace');
DELETE FROM class_progression_operations
WHERE class_id IN ('paladin', 'cleric')
   OR subclass_id IN ('justicar', 'vindicator', 'hierophant', 'exorcist');
DELETE FROM dev_progression_operations
WHERE progression_type IN ('paladin_level', 'cleric_level');

UPDATE combat_reward_participants AS participant
SET active_class_id = CASE
      WHEN settlement.status = 'completed' THEN NULL
      ELSE 'warrior'
    END
FROM combat_reward_settlements AS settlement
WHERE settlement.settlement_key = participant.settlement_key
  AND participant.active_class_id IN ('paladin', 'cleric');

-- 4. Mastery achievements and titles.
DELETE FROM player_mastery_achievements
WHERE achievement_id IN ('master_paladin', 'master_cleric');

UPDATE player_mastery_state AS state
SET equipped_title = (
      SELECT achievement.title
      FROM player_mastery_achievements AS achievement
      WHERE achievement.player_id = state.player_id
      ORDER BY achievement.completed_at, achievement.achievement_id
      LIMIT 1
    ),
    revision = state.revision + 1
WHERE state.equipped_title IN ('Master Paladin', 'Master Cleric');

UPDATE player_profiles AS profile
SET title = (
      SELECT achievement.title
      FROM player_mastery_achievements AS achievement
      WHERE achievement.player_id = profile.player_id
      ORDER BY achievement.completed_at, achievement.achievement_id
      LIMIT 1
    )
WHERE profile.title IN ('Master Paladin', 'Master Cleric');

-- 5. Skill System V3 specializations, techniques and transient runtime.
UPDATE player_specialization_state
SET active_specialization_id = CASE
      WHEN active_specialization_id IN ('paladin', 'cleric') THEN NULL
      ELSE active_specialization_id
    END,
    committed_specialization_id = CASE
      WHEN committed_specialization_id IN ('paladin', 'cleric') THEN NULL
      ELSE committed_specialization_id
    END,
    equipped_class_technique_id = CASE
      WHEN equipped_class_technique_id IN (
        'v3_paladin_aegis', 'v3_paladin_smite', 'v3_cleric_lifebinder', 'v3_cleric_purifier'
      ) THEN NULL
      ELSE equipped_class_technique_id
    END,
    revision = revision + 1
WHERE active_specialization_id IN ('paladin', 'cleric')
   OR committed_specialization_id IN ('paladin', 'cleric')
   OR equipped_class_technique_id IN (
     'v3_paladin_aegis', 'v3_paladin_smite', 'v3_cleric_lifebinder', 'v3_cleric_purifier'
   );

DELETE FROM player_specialization_ultimate_unlocks WHERE specialization_id IN ('paladin', 'cleric');
DELETE FROM specialization_ultimate_completion_identities WHERE specialization_id IN ('paladin', 'cleric');

CREATE TEMP TABLE removed_class_skill_point_players ON COMMIT DROP AS
SELECT DISTINCT player_id
FROM player_specialization_ranks
WHERE specialization_id IN ('paladin', 'cleric') OR source_class_id IN ('paladin', 'cleric');

DELETE FROM player_specialization_ranks
WHERE specialization_id IN ('paladin', 'cleric') OR source_class_id IN ('paladin', 'cleric');

-- Same reconciliation the skill authority applies on its next read.
WITH actual_spending AS (
  SELECT state.player_id,
         LEAST(25, GREATEST(0, progression.level)) AS level_entitlement,
         COALESCE(general.total_spent, 0) + COALESCE(specialization.total_spent, 0) AS total_spent
  FROM player_skill_point_state AS state
  JOIN removed_class_skill_point_players AS affected ON affected.player_id = state.player_id
  JOIN player_progression_profiles AS progression ON progression.player_id = state.player_id
  LEFT JOIN (
    SELECT player_id, SUM(points_spent)::integer AS total_spent
    FROM player_skill_ranks GROUP BY player_id
  ) AS general ON general.player_id = state.player_id
  LEFT JOIN (
    SELECT player_id, SUM(points_spent)::integer AS total_spent
    FROM player_specialization_ranks GROUP BY player_id
  ) AS specialization ON specialization.player_id = state.player_id
)
UPDATE player_skill_point_state AS state
SET total_earned = GREATEST(actual.level_entitlement, actual.total_spent),
    total_spent = actual.total_spent,
    revision = state.revision + 1
FROM actual_spending AS actual
WHERE state.player_id = actual.player_id
  AND (state.total_earned, state.total_spent) IS DISTINCT FROM
      (GREATEST(actual.level_entitlement, actual.total_spent), actual.total_spent);

UPDATE player_skill_runtime
SET cooldown_ends_at = (
      SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      FROM jsonb_each(player_skill_runtime.cooldown_ends_at) AS entry
      WHERE entry.key !~ '(paladin|cleric|justicar|vindicator|hierophant|exorcist)_'
    ),
    status_effects = (
      SELECT COALESCE(jsonb_agg(effect), '[]'::jsonb)
      FROM jsonb_array_elements(player_skill_runtime.status_effects) AS kept(effect)
      WHERE effect::text !~ '(paladin|cleric|justicar|vindicator|hierophant|exorcist)_'
    ),
    revision = revision + 1
WHERE cooldown_ends_at::text ~ '(paladin|cleric|justicar|vindicator|hierophant|exorcist)_'
   OR status_effects::text ~ '(paladin|cleric|justicar|vindicator|hierophant|exorcist)_';

-- 6. Constraints no longer admit the removed classes.
ALTER TABLE player_class_profiles
  DROP CONSTRAINT IF EXISTS player_class_profiles_active_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_profiles_active_subclass_id_check;
ALTER TABLE player_class_profiles
  ADD CONSTRAINT player_class_profiles_active_class_id_check
    CHECK (active_class_id IN ('warrior','druid','ranger','knight','ninja','hunter')),
  ADD CONSTRAINT player_class_profiles_active_subclass_id_check
    CHECK (active_subclass_id IS NULL OR active_subclass_id IN ('reaver','warden','sharpshooter','stalker'));

ALTER TABLE player_class_progress
  DROP CONSTRAINT IF EXISTS player_class_progress_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_progress_mastery_rank_v3_check;
ALTER TABLE player_class_progress
  ADD CONSTRAINT player_class_progress_class_id_check
    CHECK (class_id IN ('warrior','druid','ranger','knight','ninja','hunter')),
  ADD CONSTRAINT player_class_progress_mastery_rank_v3_check CHECK (
    (class_id IN ('warrior','druid','ranger','knight','ninja') AND curve_version = 3
      AND mastery_rank BETWEEN 0 AND 15 AND mastery_xp BETWEEN 0 AND 72000)
    OR (class_id = 'hunter' AND curve_version = 1 AND mastery_rank BETWEEN 0 AND 25 AND mastery_xp >= 0)
  );

ALTER TABLE player_subclass_progress
  DROP CONSTRAINT IF EXISTS player_subclass_progress_class_id_check,
  DROP CONSTRAINT IF EXISTS player_subclass_progress_owner_check,
  DROP CONSTRAINT IF EXISTS player_subclass_progress_subclass_id_check;
ALTER TABLE player_subclass_progress
  ADD CONSTRAINT player_subclass_progress_class_id_check CHECK (class_id IN ('warrior','hunter')),
  ADD CONSTRAINT player_subclass_progress_owner_check CHECK (
    (class_id = 'warrior' AND subclass_id IN ('reaver','warden'))
    OR (class_id = 'hunter' AND subclass_id IN ('sharpshooter','stalker'))
  ),
  ADD CONSTRAINT player_subclass_progress_subclass_id_check
    CHECK (subclass_id IN ('reaver','warden','sharpshooter','stalker'));

ALTER TABLE player_class_technique_unlocks
  DROP CONSTRAINT IF EXISTS player_class_technique_unlocks_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_technique_unlocks_subclass_id_check;
ALTER TABLE player_class_technique_unlocks
  ADD CONSTRAINT player_class_technique_unlocks_class_id_check
    CHECK (class_id IN ('warrior','druid','ranger','knight','ninja','hunter')),
  ADD CONSTRAINT player_class_technique_unlocks_subclass_id_check
    CHECK (subclass_id IS NULL OR subclass_id IN ('reaver','warden','sharpshooter','stalker'));

ALTER TABLE player_class_loadouts
  DROP CONSTRAINT IF EXISTS player_class_loadouts_class_id_check;
ALTER TABLE player_class_loadouts
  ADD CONSTRAINT player_class_loadouts_class_id_check
    CHECK (class_id IN ('warrior','druid','ranger','knight','ninja','hunter'));

ALTER TABLE player_subclass_loadouts
  DROP CONSTRAINT IF EXISTS player_subclass_loadouts_subclass_id_check;
ALTER TABLE player_subclass_loadouts
  ADD CONSTRAINT player_subclass_loadouts_subclass_id_check
    CHECK (subclass_id IN ('reaver','warden','sharpshooter','stalker'));

ALTER TABLE player_class_legacy_unlocks
  DROP CONSTRAINT IF EXISTS player_class_legacy_unlocks_completed_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_legacy_unlocks_legacy_id_check;
ALTER TABLE player_class_legacy_unlocks
  ADD CONSTRAINT player_class_legacy_unlocks_completed_class_id_check
    CHECK (completed_class_id IN ('warrior','hunter')),
  ADD CONSTRAINT player_class_legacy_unlocks_legacy_id_check
    CHECK (legacy_id IN ('warrior_legacy_iron_constitution'));

ALTER TABLE class_progression_operations
  DROP CONSTRAINT IF EXISTS class_progression_operations_class_id_check,
  DROP CONSTRAINT IF EXISTS class_progression_operations_subclass_id_check;
ALTER TABLE class_progression_operations
  ADD CONSTRAINT class_progression_operations_class_id_check
    CHECK (class_id IN ('warrior','druid','ranger','knight','ninja','hunter')),
  ADD CONSTRAINT class_progression_operations_subclass_id_check
    CHECK (subclass_id IS NULL OR subclass_id IN ('reaver','warden','sharpshooter','stalker'));

ALTER TABLE dev_progression_operations
  DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations
  ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
    'character_level','warrior_level','druid_level','ranger_level','hunter_level',
    'knight_level','ninja_level','woodcutter_level',
    'miner_level','builder_level','hunter_profession_level','oil_worker_level',
    'breeder_level','metallurgy_level','warrior_mastery','reaver_mastery','warden_mastery'
  ));

ALTER TABLE player_class_resources
  DROP CONSTRAINT IF EXISTS player_class_resources_class_id_check,
  DROP CONSTRAINT IF EXISTS player_class_resources_owner_check;
ALTER TABLE player_class_resources
  ADD CONSTRAINT player_class_resources_class_id_check
    CHECK (class_id IN ('warrior','druid','ranger','knight','ninja','hunter')),
  ADD CONSTRAINT player_class_resources_owner_check CHECK (
    (class_id = 'hunter' AND resource_id = 'focus')
    OR (class_id IN ('warrior','druid','ranger','knight','ninja') AND resource_id = 'none')
  );

ALTER TABLE player_class_unlocks
  DROP CONSTRAINT IF EXISTS player_class_unlocks_class_id_check;
ALTER TABLE player_class_unlocks
  ADD CONSTRAINT player_class_unlocks_class_id_check
    CHECK (class_id IN ('warrior','druid','ranger','knight','ninja'));

ALTER TABLE combat_reward_participants
  DROP CONSTRAINT IF EXISTS combat_reward_participants_active_class_id_check;
ALTER TABLE combat_reward_participants
  ADD CONSTRAINT combat_reward_participants_active_class_id_check CHECK (
    active_class_id IS NULL OR active_class_id IN ('warrior','druid','ranger','knight','ninja','hunter')
  );

ALTER TABLE player_mastery_achievements
  DROP CONSTRAINT IF EXISTS player_mastery_achievements_achievement_id_check;
ALTER TABLE player_mastery_achievements
  ADD CONSTRAINT player_mastery_achievements_achievement_id_check CHECK (
    achievement_id IN (
      'master_warrior','master_druid','master_ranger',
      'master_knight','master_ninja','master_woodcutter',
      'master_miner','master_builder','master_hunter','master_oil_worker',
      'master_breeder','master_metallurgy'
    )
  );

ALTER TABLE player_mastery_state
  DROP CONSTRAINT IF EXISTS player_mastery_state_equipped_title_check;
ALTER TABLE player_mastery_state
  ADD CONSTRAINT player_mastery_state_equipped_title_check CHECK (
    equipped_title IS NULL OR equipped_title IN (
      'Master Warrior','Master Druid','Master Ranger',
      'Master Knight','Master Ninja','Master Woodcutter',
      'Master Miner','Master Builder','Master Hunter','Master Oil Worker',
      'Master Breeder','Master Metallurgy'
    )
  );

ALTER TABLE player_specialization_ranks
  DROP CONSTRAINT IF EXISTS player_specialization_ranks_source_class_id_check,
  DROP CONSTRAINT IF EXISTS player_specialization_ranks_removed_class_check;
ALTER TABLE player_specialization_ranks
  ADD CONSTRAINT player_specialization_ranks_source_class_id_check CHECK (
    source_class_id IS NULL OR source_class_id IN ('warrior','druid','ranger','knight','ninja','hunter')
  ),
  ADD CONSTRAINT player_specialization_ranks_removed_class_check
    CHECK (specialization_id NOT IN ('paladin','cleric'));

ALTER TABLE player_specialization_state
  DROP CONSTRAINT IF EXISTS player_specialization_state_equipped_class_technique_check;
ALTER TABLE player_specialization_state
  ADD CONSTRAINT player_specialization_state_equipped_class_technique_check
  CHECK (equipped_class_technique_id IS NULL OR equipped_class_technique_id IN (
    'v3_warrior_anger_explosion', 'v3_warrior_is_that_it',
    'v3_ranger_double_tap', 'v3_ranger_explosive_arrow',
    'v3_ninja_shadow_mark', 'v3_ninja_parkour'
  ));

ALTER TABLE specialization_ultimate_completion_identities
  DROP CONSTRAINT IF EXISTS specialization_ultimate_completion_identities_check;
ALTER TABLE specialization_ultimate_completion_identities
  ADD CONSTRAINT specialization_ultimate_completion_identities_check
  CHECK ((specialization_id, mastery_quest_id) IN (
    ('warrior', 'warrior_mastery_trial'),
    ('knight', 'knight_mastery_trial'),
    ('legionnaire', 'legionnaire_mastery_trial'),
    ('ranger', 'ranger_mastery_trial'),
    ('mercenary', 'mercenary_mastery_trial'),
    ('sentinel', 'sentinel_mastery_trial'),
    ('assassin', 'assassin_mastery_trial'),
    ('ninja', 'ninja_mastery_trial'),
    ('monk', 'monk_mastery_trial'),
    ('rogue', 'rogue_mastery_trial'),
    ('druid', 'druid_mastery_trial'),
    ('merchant', 'merchant_mastery_trial'),
    ('artificer', 'artificer_mastery_trial'),
    ('voyager', 'voyager_mastery_trial')
  ));

-- Frozen one-time audits: keep history, reject new removed-class rows.
ALTER TABLE class_xp_curve_adjustments
  DROP CONSTRAINT IF EXISTS class_xp_curve_adjustments_class_id_check,
  DROP CONSTRAINT IF EXISTS class_xp_curve_adjustments_source_class_id_check;
ALTER TABLE class_xp_curve_adjustments
  ADD CONSTRAINT class_xp_curve_adjustments_class_id_check
    CHECK (class_id IN ('druid','ranger','knight')) NOT VALID,
  ADD CONSTRAINT class_xp_curve_adjustments_source_class_id_check
    CHECK (source_class_id IN ('hunter')) NOT VALID;

ALTER TABLE specialization_migration_audit
  DROP CONSTRAINT IF EXISTS specialization_migration_audit_source_class_id_check;
ALTER TABLE specialization_migration_audit
  ADD CONSTRAINT specialization_migration_audit_source_class_id_check
    CHECK (source_class_id IN ('warrior','druid','ranger','knight','ninja','hunter')) NOT VALID;

COMMENT ON TABLE player_class_unlocks IS
  'Permanent authoritative class entitlements; new class unlocks are free, while gold_paid preserves the historical amount charged. Paladin and Cleric were removed in 0916 with paid Gold refunded.';
