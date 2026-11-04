-- Quartz Hut: a member's personal Crystal producer, mirroring the Oil Well
-- (packages/shared/src/citySystem.ts QUARTZ_HUT_*). One reserved hut per
-- player; lazy row-locked production; harvests reuse the idempotent
-- city_oil_well_operations ledger (keyed by actor + request id, bound to the
-- structure id).

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check,
  DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'oil_well', 'quartz_hut', 'warehouse', 'cistern_warrens',
      'salon', 'city_kennel', 'market', 'monument', 'weaponsmith', 'armory',
      'barracks', 'demolition_factory', 'siege_workshop', 'powder_works'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (structure_type IN ('city_house', 'mayor_house', 'oil_well', 'quartz_hut') AND owner_player_id IS NOT NULL)
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
    (structure_type IN ('market', 'oil_well', 'quartz_hut', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works') AND tier = 1)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'quartz_hut', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works', 'monument')
  );

CREATE UNIQUE INDEX IF NOT EXISTS city_structures_one_reserved_quartz_hut_per_player_idx
  ON city_structures (owner_player_id)
  WHERE structure_type = 'quartz_hut' AND state IN ('constructing', 'active');

ALTER TABLE city_structure_operations
  DROP CONSTRAINT IF EXISTS city_structure_operations_action_check;
ALTER TABLE city_structure_operations
  ADD CONSTRAINT city_structure_operations_action_check CHECK (
    action IN (
      'build_house', 'destroy_house', 'build_oil_well', 'destroy_oil_well',
      'build_quartz_hut', 'destroy_quartz_hut',
      'build_facility', 'upgrade_facility', 'destroy_facility',
      'claim_mayor', 'relinquish_mayor', 'expire_founder_grace',
      'build_market', 'build_monument', 'upgrade_monument', 'destroy_monument'
    )
  );

CREATE TABLE IF NOT EXISTS city_quartz_hut_production (
  structure_id uuid PRIMARY KEY
    REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  stored_crystal smallint NOT NULL DEFAULT 0 CHECK (stored_crystal BETWEEN 0 AND 120),
  production_cursor timestamptz NOT NULL,
  settled_capacity smallint NOT NULL DEFAULT 120 CHECK (settled_capacity = 120),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS city_quartz_hut_production_owner_idx
  ON city_quartz_hut_production (owner_player_id);

COMMENT ON TABLE city_quartz_hut_production IS
  'Lazy, row-locked Crystal production state. No periodic production worker is required.';
