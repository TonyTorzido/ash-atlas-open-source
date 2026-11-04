-- Separate immutable permanent-stone authority from population-plan membership.
-- A spawn-rules plan may adopt an existing physical stone only when every
-- immutable authority field remains identical.

CREATE TABLE population_permanent_stone_authority_v2 (
  entity_id uuid PRIMARY KEY
    REFERENCES population_spawn_slots_v2(entity_id) ON DELETE RESTRICT,
  slot_id uuid NOT NULL UNIQUE,
  candidate_id text NOT NULL CHECK (candidate_id <> ''),
  owner_zone_id text NOT NULL CHECK (owner_zone_id <> ''),
  entity_kind text NOT NULL CHECK (entity_kind = 'stone'),
  archetype text NOT NULL CHECK (archetype = 'stone_mine'),
  stone_placement_version text NOT NULL CHECK (stone_placement_version <> ''),
  world_environment_identity_key text NOT NULL
    CHECK (world_environment_identity_key ~ '^[a-f0-9]{64}$'),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  anchor_latitude double precision NOT NULL
    CHECK (anchor_latitude BETWEEN -90 AND 90),
  anchor_longitude double precision NOT NULL
    CHECK (anchor_longitude BETWEEN -180 AND 180),
  environment_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(environment_snapshot) = 'object'),
  suppression_class text NOT NULL CHECK (suppression_class = 'none'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION validate_population_stone_authority_insert_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stored record;
BEGIN
  SELECT slot.*, plan.zone_id, plan.world_environment_identity_key
  INTO stored
  FROM population_spawn_slots_v2 AS slot
  JOIN population_zones_v2 AS plan ON plan.plan_id=slot.plan_id
  WHERE slot.entity_id=NEW.entity_id;
  IF NOT FOUND
    OR stored.generation_id IS NOT NULL
    OR stored.entity_kind <> 'stone'
    OR stored.slot_id IS DISTINCT FROM NEW.slot_id
    OR stored.candidate_id IS DISTINCT FROM NEW.candidate_id
    OR stored.zone_id IS DISTINCT FROM NEW.owner_zone_id
    OR stored.entity_kind IS DISTINCT FROM NEW.entity_kind
    OR stored.archetype IS DISTINCT FROM NEW.archetype
    OR stored.world_environment_identity_key
      IS DISTINCT FROM NEW.world_environment_identity_key
    OR stored.latitude IS DISTINCT FROM NEW.latitude
    OR stored.longitude IS DISTINCT FROM NEW.longitude
    OR stored.anchor_latitude IS DISTINCT FROM NEW.anchor_latitude
    OR stored.anchor_longitude IS DISTINCT FROM NEW.anchor_longitude
    OR stored.environment_snapshot IS DISTINCT FROM NEW.environment_snapshot
    OR stored.suppression_class IS DISTINCT FROM NEW.suppression_class
  THEN
    RAISE EXCEPTION
      'population permanent stone authority does not match its physical slot'
      USING ERRCODE = '23514',
            CONSTRAINT =
              'population_permanent_stone_authority_v2_slot_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_permanent_stone_authority_v2_validate_insert
BEFORE INSERT ON population_permanent_stone_authority_v2
FOR EACH ROW EXECUTE FUNCTION validate_population_stone_authority_insert_v2();

INSERT INTO population_permanent_stone_authority_v2 (
  entity_id, slot_id, candidate_id, owner_zone_id, entity_kind, archetype,
  stone_placement_version, world_environment_identity_key,
  latitude, longitude, anchor_latitude, anchor_longitude,
  environment_snapshot, suppression_class, created_at
)
SELECT slot.entity_id, slot.slot_id, slot.candidate_id, plan.zone_id,
       slot.entity_kind, slot.archetype,
       'population-permanent-stone-placement-v1',
       plan.world_environment_identity_key,
       slot.latitude, slot.longitude,
       slot.anchor_latitude, slot.anchor_longitude,
       slot.environment_snapshot, slot.suppression_class, slot.created_at
FROM population_spawn_slots_v2 AS slot
JOIN population_zones_v2 AS plan ON plan.plan_id = slot.plan_id
WHERE slot.entity_kind = 'stone' AND slot.generation_id IS NULL;

CREATE TABLE population_plan_permanent_stones_v2 (
  plan_id uuid NOT NULL
    REFERENCES population_zones_v2(plan_id) ON DELETE RESTRICT,
  entity_id uuid NOT NULL
    REFERENCES population_permanent_stone_authority_v2(entity_id)
    ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plan_id, entity_id)
);

CREATE OR REPLACE FUNCTION validate_population_stone_membership_insert_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan_zone_id text;
  stone_zone_id text;
BEGIN
  SELECT zone_id INTO STRICT plan_zone_id
  FROM population_zones_v2
  WHERE plan_id=NEW.plan_id;
  SELECT owner_zone_id INTO STRICT stone_zone_id
  FROM population_permanent_stone_authority_v2
  WHERE entity_id=NEW.entity_id;
  IF plan_zone_id IS DISTINCT FROM stone_zone_id THEN
    RAISE EXCEPTION
      'population plan cannot adopt a permanent stone from another physical zone'
      USING ERRCODE = '23514',
            CONSTRAINT =
              'population_plan_permanent_stones_v2_owner_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_plan_permanent_stones_v2_validate_insert
BEFORE INSERT ON population_plan_permanent_stones_v2
FOR EACH ROW EXECUTE FUNCTION validate_population_stone_membership_insert_v2();

INSERT INTO population_plan_permanent_stones_v2 (plan_id, entity_id, created_at)
SELECT slot.plan_id, slot.entity_id, slot.created_at
FROM population_spawn_slots_v2 AS slot
WHERE slot.entity_kind = 'stone' AND slot.generation_id IS NULL;

CREATE OR REPLACE FUNCTION reject_population_stone_authority_change_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'population permanent stone authority is immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'population_permanent_stone_authority_v2_immutable';
END;
$$;

CREATE TRIGGER population_permanent_stone_authority_v2_reject_change
BEFORE UPDATE OR DELETE ON population_permanent_stone_authority_v2
FOR EACH ROW EXECUTE FUNCTION reject_population_stone_authority_change_v2();

CREATE TRIGGER population_plan_permanent_stones_v2_reject_change
BEFORE UPDATE OR DELETE ON population_plan_permanent_stones_v2
FOR EACH ROW EXECUTE FUNCTION reject_population_stone_authority_change_v2();

CREATE VIEW population_plan_spawn_slots_v2 AS
SELECT slot.plan_id,
       slot.plan_id AS authority_plan_id,
       slot.generation_id,
       slot.slot_id,
       slot.entity_id,
       slot.candidate_id,
       slot.entity_kind,
       slot.archetype,
       slot.encounter_id,
       slot.pack_id,
       slot.pack_member_index,
       slot.latitude,
       slot.longitude,
       slot.geom,
       slot.anchor_latitude,
       slot.anchor_longitude,
       slot.anchor_geom,
       slot.environment_snapshot,
       slot.suppression_class,
       slot.created_at
FROM population_spawn_slots_v2 AS slot
WHERE slot.entity_kind <> 'stone'
UNION ALL
SELECT membership.plan_id,
       slot.plan_id AS authority_plan_id,
       slot.generation_id,
       slot.slot_id,
       slot.entity_id,
       slot.candidate_id,
       slot.entity_kind,
       slot.archetype,
       slot.encounter_id,
       slot.pack_id,
       slot.pack_member_index,
       slot.latitude,
       slot.longitude,
       slot.geom,
       slot.anchor_latitude,
       slot.anchor_longitude,
       slot.anchor_geom,
       slot.environment_snapshot,
       slot.suppression_class,
       slot.created_at
FROM population_plan_permanent_stones_v2 AS membership
JOIN population_spawn_slots_v2 AS slot
  ON slot.entity_id = membership.entity_id
WHERE slot.entity_kind = 'stone' AND slot.generation_id IS NULL;

CREATE TABLE population_stone_conflict_repair_receipts_v2 (
  repair_id uuid NOT NULL,
  plan_id uuid NOT NULL
    REFERENCES population_zones_v2(plan_id) ON DELETE RESTRICT,
  zone_id text NOT NULL CHECK (zone_id <> ''),
  spawn_rules_version text NOT NULL CHECK (spawn_rules_version <> ''),
  previous_status text NOT NULL CHECK (
    previous_status IN (
      'generating', 'retryable-failure', 'terminal-failure'
    )
  ),
  previous_attempt_count integer NOT NULL CHECK (previous_attempt_count >= 0),
  compatible_entity_ids uuid[] NOT NULL CHECK (
    cardinality(compatible_entity_ids) > 0
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (repair_id, plan_id)
);

CREATE UNIQUE INDEX population_stone_conflict_repair_once_v2
  ON population_stone_conflict_repair_receipts_v2 (plan_id);

CREATE OR REPLACE FUNCTION reject_population_stone_repair_receipt_change_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'population stone conflict repair receipts are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT =
            'population_stone_conflict_repair_receipts_v2_immutable';
END;
$$;

CREATE TRIGGER population_stone_conflict_repair_receipts_v2_reject_change
BEFORE UPDATE OR DELETE ON population_stone_conflict_repair_receipts_v2
FOR EACH ROW
EXECUTE FUNCTION reject_population_stone_repair_receipt_change_v2();

COMMENT ON TABLE population_permanent_stone_authority_v2 IS
  'One immutable physical authority row per permanent Population V2 stone.';
COMMENT ON TABLE population_plan_permanent_stones_v2 IS
  'Plan membership references immutable permanent stones without duplicating physical authority or state.';
COMMENT ON VIEW population_plan_spawn_slots_v2 IS
  'Serving plan slots with adopted permanent stones and plan-owned generation entities.';
COMMENT ON TABLE population_stone_conflict_repair_receipts_v2 IS
  'Append-only receipts for explicit compatible permanent-stone plan recovery.';
