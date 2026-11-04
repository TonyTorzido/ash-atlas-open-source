-- Library: a player-owned city building where players study for Folios.
-- Mirrors packages/shared/src/citySystem.ts (library) and library.ts.
-- 1. City structure constraints gain `library` (owner-built, tier 1, one live
--    per player) and the build/destroy operation actions.
-- 2. player_library_folios: the per-player Folios counter and lifetime study count.
-- 3. library_studies: one immutable row per study. UNIQUE (player, owner) is the
--    once-per-library-ever rule (a Library is identified by its owner, who has
--    at most one); UNIQUE (player, study_day) is the once-per-UTC-day rule;
--    operation_key makes a retried request replay the stored result.
-- 4. The weekly leaderboards gain the `folios_studied` category.
-- Forward-only and idempotent. No premium currency is involved.

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check,
  DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'oil_well', 'quartz_hut', 'library', 'warehouse', 'cistern_warrens',
      'salon', 'city_kennel', 'market', 'monument', 'weaponsmith', 'armory',
      'barracks', 'demolition_factory', 'siege_workshop', 'powder_works'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (structure_type IN ('city_house', 'mayor_house', 'oil_well', 'quartz_hut', 'library') AND owner_player_id IS NOT NULL)
    OR
    (structure_type IN ('barracks', 'demolition_factory') AND owner_player_id IS NOT NULL)
    OR
    (structure_type IN (
      'warehouse', 'cistern_warrens', 'salon', 'city_kennel', 'market', 'monument',
      'weaponsmith', 'armory', 'barracks', 'demolition_factory',
      'siege_workshop', 'powder_works'
    ) AND owner_player_id IS NULL)
  ),
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('oil_well', 'quartz_hut', 'library', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works') AND tier = 1)
    OR (structure_type = 'market' AND tier BETWEEN 1 AND 10)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'quartz_hut', 'library', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works', 'monument')
  );

CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_reserved_library_per_player_idx
  ON city_structures (owner_player_id)
  WHERE structure_type = 'library' AND state IN ('constructing', 'active');

ALTER TABLE city_structure_operations
  DROP CONSTRAINT IF EXISTS city_structure_operations_action_check;
ALTER TABLE city_structure_operations
  ADD CONSTRAINT city_structure_operations_action_check CHECK (
    action IN (
      'build_house', 'destroy_house', 'build_oil_well', 'destroy_oil_well',
      'build_quartz_hut', 'destroy_quartz_hut',
      'build_library', 'destroy_library',
      'build_facility', 'upgrade_facility', 'destroy_facility',
      'claim_mayor', 'relinquish_mayor', 'expire_founder_grace',
      'build_market', 'build_monument', 'upgrade_monument', 'destroy_monument',
      'war_destroyed'
    )
  );

CREATE TABLE IF NOT EXISTS player_library_folios (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  folios bigint NOT NULL DEFAULT 0 CHECK (folios >= 0),
  study_count integer NOT NULL DEFAULT 0 CHECK (study_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS player_library_folios_rank_idx
  ON player_library_folios (folios DESC, player_id);

CREATE TABLE IF NOT EXISTS library_studies (
  study_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  study_day date NOT NULL,
  folios_gained integer NOT NULL CHECK (folios_gained > 0),
  fee_gold bigint NOT NULL CHECK (fee_gold >= 0),
  owner_gold bigint NOT NULL CHECK (owner_gold >= 0 AND owner_gold <= fee_gold),
  studied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT library_studies_once_per_library UNIQUE (player_id, owner_player_id),
  CONSTRAINT library_studies_once_per_day UNIQUE (player_id, study_day)
);
CREATE INDEX IF NOT EXISTS library_studies_structure_idx ON library_studies (structure_id);

ALTER TABLE weekly_leaderboard_events
  DROP CONSTRAINT IF EXISTS weekly_leaderboard_events_source_type_check,
  DROP CONSTRAINT IF EXISTS weekly_leaderboard_events_category_check;
ALTER TABLE weekly_leaderboard_events
  ADD CONSTRAINT weekly_leaderboard_events_source_type_check
    CHECK (source_type IN (
      'flag_build', 'city_founding', 'character_xp', 'mob_death', 'tree_chop', 'library_study'
    )),
  ADD CONSTRAINT weekly_leaderboard_events_category_check
    CHECK (category IN (
      'flags_built', 'cities_founded', 'trees_chopped', 'exp_earned', 'folios_studied',
      'mysterious_travelers_killed', 'ogres_killed', 'deer_killed', 'wolves_killed',
      'resin_crawlers_killed'
    ));
ALTER TABLE weekly_leaderboard_totals
  DROP CONSTRAINT IF EXISTS weekly_leaderboard_totals_category_check;
ALTER TABLE weekly_leaderboard_totals
  ADD CONSTRAINT weekly_leaderboard_totals_category_check
    CHECK (category IN (
      'flags_built', 'cities_founded', 'trees_chopped', 'exp_earned', 'folios_studied',
      'mysterious_travelers_killed', 'ogres_killed', 'deer_killed', 'wolves_killed',
      'resin_crawlers_killed'
    ));
