-- Generalize the retained permanent-stone population into an immutable,
-- deterministic mix of stone, coal, and iron mines. Physical identities,
-- coordinates, plan memberships, lifecycle revisions, and history remain.

INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  (
    'coal', 'Coal', 'resource', true, 250,
    true, true, false, false, NULL, ARRAY['default']::text[]
  ),
  (
    'iron', 'Iron', 'resource', true, 250,
    true, true, false, false, NULL, ARRAY['default']::text[]
  )
ON CONFLICT (item_id) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  stackable=EXCLUDED.stackable,
  max_stack=EXCLUDED.max_stack,
  droppable=EXCLUDED.droppable,
  manor_storable=EXCLUDED.manor_storable,
  market_tradable=EXCLUDED.market_tradable,
  market_fungible=EXCLUDED.market_fungible,
  market_identity=EXCLUDED.market_identity,
  supported_variants=EXCLUDED.supported_variants,
  updated_at=now();

CREATE OR REPLACE FUNCTION population_permanent_mine_kind_v1(target_slot uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $$
  WITH hash AS (
    SELECT decode(md5(
      convert_to('population-permanent-mine-kind-v1', 'UTF8')
        || decode('00', 'hex')
        || convert_to(target_slot::text, 'UTF8')
    ), 'hex') AS bytes
  ), roll AS (
    SELECT (
      get_byte(bytes, 0)::bigint * 16777216
      + get_byte(bytes, 1)::bigint * 65536
      + get_byte(bytes, 2)::bigint * 256
      + get_byte(bytes, 3)::bigint
    ) AS value
    FROM hash
  )
  SELECT CASE
    WHEN value < 1431655765.3333333333 THEN 'stone'
    WHEN value < 2863311530.6666666667 THEN 'coal'
    ELSE 'iron'
  END
  FROM roll;
$$;

DROP TRIGGER population_permanent_stone_authority_v2_reject_change
  ON population_permanent_stone_authority_v2;
DROP TRIGGER population_permanent_stone_authority_v2_validate_insert
  ON population_permanent_stone_authority_v2;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='population_permanent_stone_authority_v2'::regclass
      AND contype='c'
      AND (
        pg_get_constraintdef(oid) LIKE '%entity_kind = %stone%'
        OR pg_get_constraintdef(oid) LIKE '%archetype = %stone_mine%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE population_permanent_stone_authority_v2 DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE population_permanent_stone_authority_v2
  ADD COLUMN yield_item_id text NOT NULL DEFAULT 'stone'
    REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  ADD COLUMN yield_quantity integer NOT NULL DEFAULT 1
    CHECK (yield_quantity > 0),
  ADD COLUMN regeneration_interval interval NOT NULL
    DEFAULT interval '5 hours 50 minutes'
    CHECK (regeneration_interval > interval '0'),
  ADD COLUMN timer_profession_id text NOT NULL DEFAULT 'miner'
    CHECK (timer_profession_id <> ''),
  ADD COLUMN timer_visibility_rank integer NOT NULL DEFAULT 2
    CHECK (timer_visibility_rank >= 0);

UPDATE population_permanent_stone_authority_v2
SET entity_kind=population_permanent_mine_kind_v1(slot_id),
    archetype=population_permanent_mine_kind_v1(slot_id) || '_mine',
    yield_item_id=population_permanent_mine_kind_v1(slot_id),
    yield_quantity=1,
    regeneration_interval=interval '5 hours 50 minutes',
    timer_profession_id='miner',
    timer_visibility_rank=2;

ALTER TABLE population_permanent_stone_authority_v2
  ADD CONSTRAINT population_permanent_mine_kind_check CHECK (
    entity_kind IN ('stone', 'coal', 'iron')
  ),
  ADD CONSTRAINT population_permanent_mine_definition_check CHECK (
    archetype=entity_kind || '_mine'
    AND yield_item_id=entity_kind
    AND yield_quantity=1
    AND regeneration_interval=interval '5 hours 50 minutes'
    AND timer_profession_id='miner'
    AND timer_visibility_rank=2
  ),
  ADD CONSTRAINT population_permanent_mine_classifier_check CHECK (
    entity_kind=population_permanent_mine_kind_v1(slot_id)
  );

CREATE OR REPLACE FUNCTION validate_population_mine_authority_insert_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stored record;
BEGIN
  SELECT slot.*, plan.zone_id, plan.world_environment_identity_key
  INTO stored
  FROM population_spawn_slots_v2 AS slot
  JOIN population_zones_v2 AS plan ON plan.plan_id=slot.plan_id
  WHERE slot.entity_id=NEW.entity_id;
  IF NOT FOUND
    OR stored.generation_id IS NOT NULL
    OR stored.slot_id IS DISTINCT FROM NEW.slot_id
    OR stored.candidate_id IS DISTINCT FROM NEW.candidate_id
    OR stored.zone_id IS DISTINCT FROM NEW.owner_zone_id
    OR stored.world_environment_identity_key
      IS DISTINCT FROM NEW.world_environment_identity_key
    OR stored.latitude IS DISTINCT FROM NEW.latitude
    OR stored.longitude IS DISTINCT FROM NEW.longitude
    OR stored.anchor_latitude IS DISTINCT FROM NEW.anchor_latitude
    OR stored.anchor_longitude IS DISTINCT FROM NEW.anchor_longitude
    OR stored.environment_snapshot IS DISTINCT FROM NEW.environment_snapshot
    OR stored.suppression_class IS DISTINCT FROM NEW.suppression_class
    OR NEW.entity_kind IS DISTINCT FROM
      population_permanent_mine_kind_v1(NEW.slot_id)
    OR NEW.archetype IS DISTINCT FROM NEW.entity_kind || '_mine'
    OR NEW.yield_item_id IS DISTINCT FROM NEW.entity_kind
    OR NEW.yield_quantity <> 1
    OR NEW.regeneration_interval <> interval '5 hours 50 minutes'
    OR NEW.timer_profession_id <> 'miner'
    OR NEW.timer_visibility_rank <> 2
  THEN
    RAISE EXCEPTION
      'population permanent mine authority does not match its physical slot'
      USING ERRCODE='23514',
            CONSTRAINT='population_permanent_mine_authority_v2_slot_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_permanent_stone_authority_v2_validate_insert
BEFORE INSERT ON population_permanent_stone_authority_v2
FOR EACH ROW EXECUTE FUNCTION validate_population_mine_authority_insert_v2();

CREATE OR REPLACE FUNCTION reject_population_stone_authority_change_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'population permanent mine authority is immutable'
    USING ERRCODE='23514',
          CONSTRAINT='population_permanent_stone_authority_v2_immutable';
END;
$$;

CREATE TRIGGER population_permanent_stone_authority_v2_reject_change
BEFORE UPDATE OR DELETE ON population_permanent_stone_authority_v2
FOR EACH ROW EXECUTE FUNCTION reject_population_stone_authority_change_v2();

CREATE OR REPLACE VIEW population_permanent_resource_authority_v2 AS
SELECT authority.entity_id, authority.owner_zone_id,
       authority.entity_kind, authority.archetype AS node_type,
       authority.yield_item_id, authority.yield_quantity,
       authority.regeneration_interval, authority.timer_profession_id,
       authority.timer_visibility_rank,
       authority.slot_id, authority.candidate_id, authority.archetype,
       authority.stone_placement_version,
       authority.world_environment_identity_key,
       authority.latitude, authority.longitude,
       authority.anchor_latitude, authority.anchor_longitude,
       authority.environment_snapshot, authority.suppression_class,
       authority.created_at
FROM population_permanent_stone_authority_v2 AS authority;

CREATE OR REPLACE VIEW population_plan_permanent_resources_v2 AS
SELECT membership.plan_id, membership.entity_id, membership.created_at
FROM population_plan_permanent_stones_v2 AS membership;

CREATE OR REPLACE VIEW population_plan_spawn_slots_v2 AS
SELECT slot.plan_id, slot.plan_id AS authority_plan_id,
       slot.generation_id, slot.slot_id, slot.entity_id, slot.candidate_id,
       slot.entity_kind, slot.archetype, slot.encounter_id, slot.pack_id,
       slot.pack_member_index, slot.latitude, slot.longitude, slot.geom,
       slot.anchor_latitude, slot.anchor_longitude, slot.anchor_geom,
       slot.environment_snapshot, slot.suppression_class, slot.created_at
FROM population_spawn_slots_v2 AS slot
WHERE slot.generation_id IS NOT NULL
UNION ALL
SELECT membership.plan_id, slot.plan_id AS authority_plan_id,
       slot.generation_id, slot.slot_id, slot.entity_id, slot.candidate_id,
       authority.entity_kind, authority.node_type,
       slot.encounter_id, slot.pack_id, slot.pack_member_index,
       slot.latitude, slot.longitude, slot.geom,
       slot.anchor_latitude, slot.anchor_longitude, slot.anchor_geom,
       slot.environment_snapshot, slot.suppression_class, slot.created_at
FROM population_plan_permanent_resources_v2 AS membership
JOIN population_permanent_resource_authority_v2 AS authority
  ON authority.entity_id=membership.entity_id
JOIN population_spawn_slots_v2 AS slot
  ON slot.entity_id=authority.entity_id
WHERE slot.generation_id IS NULL;

ALTER TABLE population_spawn_slots_v2
  DROP CONSTRAINT population_spawn_slots_v2_lifecycle_shape,
  DROP CONSTRAINT population_spawn_slots_v2_entity_shape_check,
  ADD CONSTRAINT population_spawn_slots_v2_lifecycle_shape CHECK (
    (
      entity_kind IN ('stone', 'coal', 'iron')
      AND generation_id IS NULL
    )
    OR
    (
      entity_kind NOT IN ('stone', 'coal', 'iron')
      AND generation_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT population_spawn_slots_v2_entity_shape_check CHECK (
    (
      archetype IN ('tree', 'stone_mine', 'coal_mine', 'iron_mine')
      AND encounter_id IS NULL AND pack_id IS NULL
      AND pack_member_index IS NULL
    )
    OR
    (
      archetype NOT IN ('tree', 'stone_mine', 'coal_mine', 'iron_mine')
      AND encounter_id IS NOT NULL
      AND (
        (pack_id IS NULL AND pack_member_index IS NULL)
        OR (pack_id IS NOT NULL AND pack_member_index IS NOT NULL)
      )
    )
  );

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='repeatable_resource_nodes'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%node_type%'
  LOOP
    EXECUTE format(
      'ALTER TABLE repeatable_resource_nodes DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE repeatable_resource_nodes
  ADD CONSTRAINT repeatable_resource_nodes_node_type_check CHECK (
    node_type IN ('stone_mine', 'coal_mine', 'iron_mine')
  ),
  ADD CONSTRAINT repeatable_resource_nodes_mine_definition_check CHECK (
    node_type=yield_item_id || '_mine'
    AND yield_item_id IN ('stone', 'coal', 'iron')
    AND yield_quantity=1
    AND regeneration_interval=interval '5 hours 50 minutes'
  ),
  ADD CONSTRAINT repeatable_resource_nodes_population_v2_owner_complete CHECK (
    (population_v2_entity_id IS NULL AND population_v2_plan_id IS NULL
      AND population_v2_state_revision IS NULL)
    OR
    (population_v2_entity_id IS NOT NULL
      AND population_v2_plan_id IS NOT NULL
      AND population_v2_state_revision IS NOT NULL
      AND physical_population_zone_v2_id IS NOT NULL
      AND population_cutover_revision IS NOT NULL
      AND node_type IN ('stone_mine', 'coal_mine', 'iron_mine')
      AND authored_source='population-v2')
  );

UPDATE repeatable_resource_nodes AS projection
SET node_type=authority.node_type,
    yield_item_id=authority.yield_item_id,
    yield_quantity=authority.yield_quantity,
    regeneration_interval=authority.regeneration_interval
FROM population_permanent_resource_authority_v2 AS authority
WHERE projection.population_v2_entity_id=authority.entity_id;

UPDATE repeatable_resource_sessions AS session
SET resource_type=authority.yield_item_id
FROM population_permanent_resource_authority_v2 AS authority
WHERE session.node_id=authority.entity_id
  AND session.status='active';

COMMENT ON VIEW population_permanent_resource_authority_v2 IS
  'Immutable physical authority and lifecycle definition for every permanent repeatable resource.';
COMMENT ON VIEW population_plan_permanent_resources_v2 IS
  'Selected-plan membership for every permanent repeatable resource.';
COMMENT ON VIEW population_plan_spawn_slots_v2 IS
  'Serving plan slots with adopted permanent mines and plan-owned generation entities.';
