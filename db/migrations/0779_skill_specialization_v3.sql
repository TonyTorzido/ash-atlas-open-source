-- Skill Tree / Specialization V3 durable foundation and legacy projection.
-- Historical class progression, XP, unlocks, and loadouts remain intact.

LOCK TABLE players, player_progression_profiles, player_class_profiles,
  player_class_progress, player_class_unlocks, player_class_loadouts,
  player_class_runtime IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS player_skill_point_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  total_earned smallint NOT NULL CHECK (total_earned BETWEEN 0 AND 50),
  total_spent smallint NOT NULL DEFAULT 0 CHECK (
    total_spent >= 0 AND total_spent <= total_earned
  ),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_skill_ranks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  skill_id text NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 80),
  rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 3),
  points_spent smallint NOT NULL DEFAULT 0 CHECK (points_spent >= 0),
  grandfathered boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, skill_id)
);

CREATE TABLE IF NOT EXISTS skill_point_operations (
  operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 200),
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  result jsonb NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (operation_key, player_id),
  CHECK ((result IS NULL) = (completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS player_specialization_ranks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  specialization_id text NOT NULL CHECK (length(specialization_id) BETWEEN 1 AND 80),
  rank smallint NOT NULL CHECK (rank BETWEEN 0 AND 5),
  points_spent smallint NOT NULL DEFAULT 0 CHECK (points_spent >= 0),
  grandfathered boolean NOT NULL DEFAULT false,
  source_class_id text NULL CHECK (
    source_class_id IS NULL OR source_class_id IN (
      'warrior','druid','ranger','paladin','knight','cleric','ninja','hunter'
    )
  ),
  source_rank smallint NULL CHECK (source_rank IS NULL OR source_rank BETWEEN 0 AND 25),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, specialization_id),
  CHECK ((source_class_id IS NULL) = (source_rank IS NULL)),
  CHECK (NOT grandfathered OR source_class_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS player_specialization_state (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  active_specialization_id text NULL CHECK (
    active_specialization_id IS NULL OR length(active_specialization_id) BETWEEN 1 AND 80
  ),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (player_id, active_specialization_id)
    REFERENCES player_specialization_ranks(player_id, specialization_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS player_general_active_loadouts (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  slot_one_skill_id text NULL CHECK (
    slot_one_skill_id IS NULL OR length(slot_one_skill_id) BETWEEN 1 AND 80
  ),
  slot_two_skill_id text NULL CHECK (
    slot_two_skill_id IS NULL OR length(slot_two_skill_id) BETWEEN 1 AND 80
  ),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (player_id, slot_one_skill_id)
    REFERENCES player_skill_ranks(player_id, skill_id) ON DELETE RESTRICT,
  FOREIGN KEY (player_id, slot_two_skill_id)
    REFERENCES player_skill_ranks(player_id, skill_id) ON DELETE RESTRICT,
  CHECK (
    slot_one_skill_id IS NULL OR slot_two_skill_id IS NULL
    OR slot_one_skill_id <> slot_two_skill_id
  )
);

CREATE TABLE IF NOT EXISTS player_skill_runtime (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  cooldown_ends_at jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(cooldown_ends_at) = 'object'),
  status_effects jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(status_effects) = 'array'),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(counters) = 'object'),
  engaged_target jsonb NULL
    CHECK (engaged_target IS NULL OR jsonb_typeof(engaged_target) = 'object'),
  combat_generation bigint NOT NULL DEFAULT 0 CHECK (combat_generation >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS specialization_migration_audit (
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source_class_id text NOT NULL CHECK (
    source_class_id IN (
      'warrior','druid','ranger','paladin','knight','cleric','ninja','hunter'
    )
  ),
  source_mastery_rank smallint NOT NULL CHECK (source_mastery_rank BETWEEN 0 AND 25),
  source_mastery_xp integer NOT NULL CHECK (source_mastery_xp >= 0),
  source_curve_version smallint NOT NULL CHECK (source_curve_version > 0),
  resulting_specialization_id text NOT NULL CHECK (
    length(resulting_specialization_id) BETWEEN 1 AND 80
  ),
  resulting_rank smallint NOT NULL CHECK (resulting_rank BETWEEN 0 AND 5),
  grandfathered boolean NOT NULL,
  migration_version smallint NOT NULL DEFAULT 3 CHECK (migration_version = 3),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, source_class_id, migration_version)
);

CREATE TABLE IF NOT EXISTS player_skill_world_unlocks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  skill_id text NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 80),
  revealed_at timestamptz NOT NULL DEFAULT now(),
  operation_key text NOT NULL,
  PRIMARY KEY (player_id, skill_id),
  UNIQUE (operation_key),
  FOREIGN KEY (operation_key, player_id)
    REFERENCES skill_point_operations(operation_key, player_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS skill_point_operations_player_created_idx
  ON skill_point_operations (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS specialization_migration_audit_player_created_idx
  ON specialization_migration_audit (player_id, created_at DESC);

DROP TRIGGER IF EXISTS player_skill_point_state_set_updated_at ON player_skill_point_state;
CREATE TRIGGER player_skill_point_state_set_updated_at BEFORE UPDATE ON player_skill_point_state
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_skill_ranks_set_updated_at ON player_skill_ranks;
CREATE TRIGGER player_skill_ranks_set_updated_at BEFORE UPDATE ON player_skill_ranks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_specialization_ranks_set_updated_at ON player_specialization_ranks;
CREATE TRIGGER player_specialization_ranks_set_updated_at BEFORE UPDATE ON player_specialization_ranks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_specialization_state_set_updated_at ON player_specialization_state;
CREATE TRIGGER player_specialization_state_set_updated_at BEFORE UPDATE ON player_specialization_state
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_general_active_loadouts_set_updated_at ON player_general_active_loadouts;
CREATE TRIGGER player_general_active_loadouts_set_updated_at BEFORE UPDATE ON player_general_active_loadouts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS player_skill_runtime_set_updated_at ON player_skill_runtime;
CREATE TRIGGER player_skill_runtime_set_updated_at BEFORE UPDATE ON player_skill_runtime
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Level entitlement is authoritative and independent of dormant training-point fields.
INSERT INTO player_skill_point_state (player_id, total_earned, total_spent)
SELECT players.id, LEAST(25, GREATEST(0, progression.level)) * 2, 0
FROM players
JOIN player_progression_profiles AS progression ON progression.player_id = players.id
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO player_general_active_loadouts (player_id)
SELECT id FROM players
ON CONFLICT (player_id) DO NOTHING;

-- V3 cooldowns, effects, counters, and engagement start empty. Legacy V2
-- transient state is fenced below and is never promoted into this authority.
INSERT INTO player_skill_runtime (player_id)
SELECT id FROM players
ON CONFLICT (player_id) DO NOTHING;

-- Durable curve_version selects the mapping. Current launch curve 3 is 0-15;
-- retained historical curve 1 is 0-25. No XP range is used to infer provenance.
CREATE TEMP TABLE skill_v3_class_projection ON COMMIT DROP AS
SELECT progress.player_id,
       progress.class_id AS source_class_id,
       progress.mastery_rank AS source_mastery_rank,
       progress.mastery_xp AS source_mastery_xp,
       progress.curve_version AS source_curve_version,
       CASE progress.class_id WHEN 'hunter' THEN 'ranger' ELSE progress.class_id END
         AS resulting_specialization_id,
       CASE
         WHEN progress.curve_version = 3 THEN
           CASE WHEN progress.mastery_rank = 0 THEN 0
                ELSE CEIL(progress.mastery_rank::numeric / 3)::smallint END
         WHEN progress.curve_version = 1 THEN
           CASE WHEN progress.mastery_rank = 0 THEN 0
                ELSE CEIL(progress.mastery_rank::numeric / 5)::smallint END
       END AS resulting_rank,
       (
         progress.class_id = 'warrior'
         OR progress.mastery_rank > 0
         OR EXISTS (
           SELECT 1 FROM player_class_unlocks AS entitlement
           WHERE entitlement.player_id = progress.player_id
             AND entitlement.class_id = progress.class_id
         )
         OR EXISTS (
           SELECT 1 FROM player_class_profiles AS profile
           WHERE profile.player_id = progress.player_id
             AND profile.active_class_id = progress.class_id
         )
       ) AS grandfathered,
       EXISTS (
         SELECT 1 FROM player_class_unlocks AS entitlement
         WHERE entitlement.player_id = progress.player_id
           AND entitlement.class_id = progress.class_id
       ) AS had_unlock,
       EXISTS (
         SELECT 1 FROM player_class_profiles AS profile
         WHERE profile.player_id = progress.player_id
           AND profile.active_class_id = progress.class_id
       ) AS was_active,
       loadout.base_active_ids,
       loadout.base_passive_ids,
       loadout.reset_active_ids,
       loadout.normal_active_ids,
       loadout.passive_tier_ids,
       loadout.ultimate_active_id,
       loadout.revision AS loadout_revision
FROM player_class_progress AS progress
LEFT JOIN player_class_loadouts AS loadout
  ON loadout.player_id = progress.player_id AND loadout.class_id = progress.class_id
WHERE (progress.curve_version = 3 AND progress.mastery_rank BETWEEN 0 AND 15)
   OR (progress.curve_version = 1 AND progress.mastery_rank BETWEEN 0 AND 25);

INSERT INTO specialization_migration_audit (
  player_id, source_class_id, source_mastery_rank, source_mastery_xp,
  source_curve_version, resulting_specialization_id, resulting_rank,
  grandfathered, metadata
)
SELECT player_id, source_class_id, source_mastery_rank, source_mastery_xp,
       source_curve_version, resulting_specialization_id, resulting_rank,
       grandfathered,
       jsonb_build_object(
         'hadUnlock', had_unlock,
         'wasActive', was_active,
         'legacyLoadoutStatus', 'legacy_inert',
         'legacyLoadout', CASE WHEN loadout_revision IS NULL THEN NULL ELSE jsonb_build_object(
           'baseActiveIds', base_active_ids,
           'basePassiveIds', base_passive_ids,
           'resetActiveIds', reset_active_ids,
           'normalActiveIds', normal_active_ids,
           'passiveTierIds', passive_tier_ids,
           'ultimateActiveId', ultimate_active_id,
           'revision', loadout_revision
         ) END
       )
FROM skill_v3_class_projection
ON CONFLICT (player_id, source_class_id, migration_version) DO NOTHING;

-- An entitlement, an active selection, positive historical progress, or the
-- safe Warrior starter grant is retained without charging general Skill Points.
INSERT INTO player_specialization_ranks (
  player_id, specialization_id, rank, points_spent, grandfathered,
  source_class_id, source_rank
)
SELECT player_id, resulting_specialization_id, resulting_rank, 0, true,
       source_class_id, source_mastery_rank
FROM (
  SELECT projection.*,
         ROW_NUMBER() OVER (
           PARTITION BY player_id, resulting_specialization_id
           ORDER BY resulting_rank DESC,
                    (source_curve_version = 3) DESC,
                    (source_class_id = resulting_specialization_id) DESC,
                    source_class_id
         ) AS source_priority
  FROM skill_v3_class_projection AS projection
  WHERE grandfathered
) AS retained
WHERE source_priority = 1
ON CONFLICT (player_id, specialization_id) DO NOTHING;

INSERT INTO player_specialization_state (player_id, active_specialization_id)
SELECT profile.player_id,
       CASE profile.active_class_id WHEN 'hunter' THEN 'ranger' ELSE profile.active_class_id END
FROM player_class_profiles AS profile
WHERE EXISTS (
  SELECT 1 FROM player_specialization_ranks AS ranks
  WHERE ranks.player_id = profile.player_id
    AND ranks.specialization_id = CASE profile.active_class_id
      WHEN 'hunter' THEN 'ranger' ELSE profile.active_class_id END
)
ON CONFLICT (player_id) DO NOTHING;

-- Old saved class loadouts remain queryable and fully audited, but are not V3
-- executable state. The new general-active loadout is the live V3 authority.
ALTER TABLE player_class_loadouts
  ADD COLUMN IF NOT EXISTS v3_execution_status text NULL;
ALTER TABLE player_class_loadouts
  ALTER COLUMN v3_execution_status SET DEFAULT 'legacy_inert';
DO $$ BEGIN
  ALTER TABLE player_class_loadouts ADD CONSTRAINT player_class_loadouts_v3_execution_status_check
    CHECK (v3_execution_status IN ('legacy_executable', 'legacy_inert'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
UPDATE player_class_loadouts
SET v3_execution_status = 'legacy_inert', updated_at = now()
WHERE v3_execution_status IS DISTINCT FROM 'legacy_inert';
ALTER TABLE player_class_loadouts
  ALTER COLUMN v3_execution_status SET NOT NULL;

-- Fence only transient durable V2 runtime state. Earned XP, ranks, resources,
-- unlocks, and saved loadout arrays are deliberately untouched. Guardian
-- Bubble remains a live V3 Paladin innate, so only its precisely identifiable
-- externally applied Ward effect survives. Saving Grace life/downed and party
-- cooldown authority lives outside this legacy runtime table and is untouched.
ALTER TABLE player_class_runtime
  ADD COLUMN IF NOT EXISTS v3_execution_status text NULL,
  ADD COLUMN IF NOT EXISTS v3_fenced_at timestamptz NULL;
ALTER TABLE player_class_runtime
  ALTER COLUMN v3_execution_status SET DEFAULT 'legacy_inert';
DO $$ BEGIN
  ALTER TABLE player_class_runtime ADD CONSTRAINT player_class_runtime_v3_execution_status_check
    CHECK (v3_execution_status IN ('legacy_executable', 'legacy_inert'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
UPDATE player_class_runtime
SET rage_reserved = 0,
    queued_ability_id = NULL,
    queued_target_entity_id = NULL,
    queued_at_tick = NULL,
    cooldown_ends_at = '{}'::jsonb,
    status_effects = COALESCE((
      SELECT jsonb_agg(effect)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(player_class_runtime.status_effects) = 'array'
          THEN player_class_runtime.status_effects ELSE '[]'::jsonb END
      ) AS retained(effect)
      WHERE effect->>'sourceTechniqueId' = 'paladin_guardian_bubble'
    ), '[]'::jsonb),
    counters = '{}'::jsonb,
    combat_generation = combat_generation + 1,
    last_combat_at = NULL,
    revision = revision + 1,
    v3_execution_status = 'legacy_inert',
    v3_fenced_at = now(),
    updated_at = now()
WHERE v3_execution_status IS DISTINCT FROM 'legacy_inert';
ALTER TABLE player_class_runtime
  ALTER COLUMN v3_execution_status SET NOT NULL;

COMMENT ON TABLE player_skill_point_state IS
  'Authoritative V3 general Skill Point entitlement and spending balance; level grants are capped at 50.';
COMMENT ON TABLE player_specialization_ranks IS
  'V3 specialization ranks. Grandfathered launch ranks cost zero general Skill Points.';
COMMENT ON TABLE player_skill_runtime IS
  'Dedicated V3 transient runtime authority; namespaced cooldowns and effects never reuse inert legacy class runtime state.';
COMMENT ON TABLE specialization_migration_audit IS
  'Immutable V3 projection audit retaining old rank, XP, curve provenance, entitlement evidence, and saved loadout snapshot.';
COMMENT ON TABLE player_skill_world_unlocks IS
  'Authoritative hidden-world-knowledge reveal state backed by the V3 operation ledger.';
