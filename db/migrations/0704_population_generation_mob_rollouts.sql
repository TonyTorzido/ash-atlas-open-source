-- One per-generation manifest/receipt for registered Population V2 mobs.
--
-- Natural generation creation records the registered revisions intentionally
-- included in that generation. Explicit existing-generation top-ups use the
-- same rows as durable receipts. Legacy generations intentionally remain
-- valid without rows in this table.

ALTER TABLE population_spawn_slots_v2
  DROP CONSTRAINT population_spawn_slots_v2_entity_kind_check,
  DROP CONSTRAINT population_spawn_slots_v2_entity_shape_check,
  ADD CONSTRAINT population_spawn_slots_v2_entity_kind_check CHECK (
    btrim(entity_kind) <> ''
    AND char_length(entity_kind) <= 64
    AND entity_kind ~ '^[a-z][a-z0-9_]*$'
  ),
  ADD CONSTRAINT population_spawn_slots_v2_entity_shape_check CHECK (
    (
      archetype IN ('tree', 'stone_mine')
      AND encounter_id IS NULL
      AND pack_id IS NULL
      AND pack_member_index IS NULL
    )
    OR
    (
      archetype NOT IN ('tree', 'stone_mine')
      AND encounter_id IS NOT NULL
      AND (
        (pack_id IS NULL AND pack_member_index IS NULL)
        OR
        (pack_id IS NOT NULL AND pack_member_index IS NOT NULL)
      )
    )
  );

ALTER TABLE generated_world_mobs
  DROP CONSTRAINT generated_world_mobs_mob_archetype_check,
  DROP CONSTRAINT generated_world_mobs_group_shape_check,
  ADD CONSTRAINT generated_world_mobs_mob_archetype_check CHECK (
    btrim(mob_archetype) <> ''
    AND char_length(mob_archetype) <= 64
    AND mob_archetype ~ '^[a-z][a-z0-9_]*$'
  ),
  ADD CONSTRAINT generated_world_mobs_group_shape_check CHECK (
    population_v2_entity_id IS NOT NULL
    OR (
      mob_archetype IN ('wolf', 'sap_crawler')
      AND pack_id IS NOT NULL
    )
    OR (
      mob_archetype IN ('deer', 'ogre')
      AND pack_id IS NULL
    )
  );

CREATE OR REPLACE FUNCTION
  validate_population_v2_generated_mob_registry_shape()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  slot_archetype text;
  slot_encounter_id text;
  slot_pack_id text;
BEGIN
  IF NEW.population_v2_entity_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.population_v2_plan_id IS NULL THEN
    RAISE EXCEPTION
      'Population V2 generated mob projection has no plan authority'
      USING ERRCODE = '23514',
            CONSTRAINT =
              'generated_world_mobs_population_v2_registry_shape';
  END IF;

  SELECT slot.archetype, slot.encounter_id::text, slot.pack_id::text
    INTO STRICT slot_archetype, slot_encounter_id, slot_pack_id
  FROM population_spawn_slots_v2 AS slot
  WHERE slot.plan_id=NEW.population_v2_plan_id
    AND slot.entity_id=NEW.population_v2_entity_id;

  IF slot_archetype IS DISTINCT FROM NEW.mob_archetype
     OR slot_encounter_id IS DISTINCT FROM NEW.encounter_id
     OR slot_pack_id IS DISTINCT FROM NEW.pack_id
  THEN
    RAISE EXCEPTION
      'Population V2 generated mob projection does not match its spawn slot'
      USING ERRCODE = '23514',
            CONSTRAINT =
              'generated_world_mobs_population_v2_registry_shape';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION
      'Population V2 generated mob projection has no spawn-slot authority'
      USING ERRCODE = '23514',
            CONSTRAINT =
              'generated_world_mobs_population_v2_registry_shape';
END;
$$;

CREATE TRIGGER generated_world_mobs_population_v2_registry_shape
BEFORE INSERT OR UPDATE OF
  population_v2_entity_id, population_v2_plan_id,
  mob_archetype, encounter_id, pack_id
ON generated_world_mobs
FOR EACH ROW
EXECUTE FUNCTION validate_population_v2_generated_mob_registry_shape();

CREATE TABLE population_generation_mob_rollouts_v2 (
  generation_id uuid NOT NULL
    REFERENCES population_zone_generations_v2(generation_id)
    ON DELETE RESTRICT,
  mob_kind text NOT NULL CHECK (mob_kind <> ''),
  rollout_revision text NOT NULL CHECK (rollout_revision <> ''),
  source text NOT NULL CHECK (source IN ('generation', 'top_up')),
  status text NOT NULL CHECK (
    status IN (
      'completed',
      'completed_with_shortfall',
      'retryable_failure',
      'terminal_diagnostic'
    )
  ),
  target_group_count integer NOT NULL DEFAULT 0
    CHECK (target_group_count >= 0),
  target_body_count integer NOT NULL DEFAULT 0
    CHECK (target_body_count >= 0),
  inserted_group_count integer NOT NULL DEFAULT 0
    CHECK (inserted_group_count >= 0),
  inserted_body_count integer NOT NULL DEFAULT 0
    CHECK (inserted_body_count >= 0),
  shortfall_group_count integer NOT NULL DEFAULT 0
    CHECK (shortfall_group_count >= 0),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  next_retry_at timestamptz NULL,
  last_error text NULL CHECK (
    last_error IS NULL OR char_length(last_error) <= 1000
  ),
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (generation_id, mob_kind, rollout_revision),
  CHECK (inserted_group_count <= target_group_count),
  CHECK (inserted_body_count <= target_body_count),
  CHECK (
    (status IN ('completed', 'completed_with_shortfall')
      AND completed_at IS NOT NULL
      AND next_retry_at IS NULL)
    OR
    (status = 'retryable_failure'
      AND completed_at IS NULL
      AND next_retry_at IS NOT NULL)
    OR
    (status = 'terminal_diagnostic'
      AND completed_at IS NOT NULL
      AND next_retry_at IS NULL)
  ),
  CHECK (
    status <> 'completed'
    OR shortfall_group_count = 0
  ),
  CHECK (
    status <> 'completed_with_shortfall'
    OR shortfall_group_count > 0
  )
);

CREATE INDEX population_generation_mob_rollouts_v2_retry_idx
  ON population_generation_mob_rollouts_v2 (
    next_retry_at,
    generation_id,
    mob_kind,
    rollout_revision
  )
  WHERE status = 'retryable_failure';

COMMENT ON TABLE population_generation_mob_rollouts_v2 IS
  'Immutable registered-mob generation manifest plus bounded optional top-up receipt; absence never affects Population V2 generation servability.';

COMMENT ON CONSTRAINT population_spawn_slots_v2_entity_kind_check
  ON population_spawn_slots_v2 IS
  'Population V2 registry kinds are open-ended nonempty durable identifiers.';

COMMENT ON CONSTRAINT population_spawn_slots_v2_entity_shape_check
  ON population_spawn_slots_v2 IS
  'Resources have no encounter identity; registered mobs are either single encounter bodies or indexed pack bodies.';

COMMENT ON CONSTRAINT generated_world_mobs_mob_archetype_check
  ON generated_world_mobs IS
  'Population V2 registry archetypes are open-ended nonempty durable identifiers.';

COMMENT ON CONSTRAINT generated_world_mobs_group_shape_check
  ON generated_world_mobs IS
  'Legacy projections retain their known group shape; Population V2 projection shape is matched to its authoritative spawn slot by trigger.';
