-- Population v2-only lifecycle correction.
--
-- This test-server reset intentionally removes every legacy population row
-- and every pre-generation Population v2 projection. Unrelated player,
-- account, flag, city, kingdom, inventory, and progression rows are retained.

DROP TRIGGER IF EXISTS population_zone_cutover_operations_v2_reject_change
  ON population_zone_cutover_operations_v2;
DROP TRIGGER IF EXISTS population_zones_v2_protect_ready
  ON population_zones_v2;
DROP TRIGGER IF EXISTS population_spawn_slots_v2_protect_ready
  ON population_spawn_slots_v2;
DROP TRIGGER IF EXISTS population_v2_rollout_control_delete_guard
  ON population_v2_rollout_control;
DROP TRIGGER IF EXISTS population_v2_rollout_audit_append_only
  ON population_v2_rollout_audit;
DROP TRIGGER IF EXISTS population_v2_rollout_change_guard
  ON population_v2_rollout_control;

DROP TRIGGER IF EXISTS collectible_nodes_classify_v1_population_v2
  ON collectible_nodes;
DROP TRIGGER IF EXISTS generated_world_mobs_classify_v1_population_v2
  ON generated_world_mobs;
DROP TRIGGER IF EXISTS repeatable_resource_nodes_classify_v1_population_v2
  ON repeatable_resource_nodes;
DROP TRIGGER IF EXISTS collectible_nodes_global_v1_population_fence
  ON collectible_nodes;
DROP TRIGGER IF EXISTS generated_world_mobs_global_v1_population_fence
  ON generated_world_mobs;
DROP TRIGGER IF EXISTS repeatable_resource_nodes_global_v1_population_fence
  ON repeatable_resource_nodes;

-- Remove V1 flag/cell generation hooks before their backing tables.
DROP TRIGGER IF EXISTS flags_initialize_resource_spawn_allowance ON flags;
DROP TRIGGER IF EXISTS flags_deactivate_resource_spawn_allowance ON flags;
DROP TRIGGER IF EXISTS flag_resource_spawn_events_immutable
  ON flag_resource_spawn_events;
DROP FUNCTION IF EXISTS initialize_flag_resource_spawn_allowance();
DROP FUNCTION IF EXISTS deactivate_flag_resource_spawn_allowance();
DROP FUNCTION IF EXISTS protect_flag_resource_generation_audit();

-- Collectible rows before this migration are all population-era projections.
-- Some early writers did not persist provenance, so filtering by nullable
-- ownership columns would let obsolete trees survive the V2-only reset.
-- Harvest sessions must be removed first because they RESTRICT node deletion.
DELETE FROM harvest_sessions;

DELETE FROM repeatable_resource_sessions
WHERE node_id IN (
  SELECT id FROM repeatable_resource_nodes
);
DELETE FROM repeatable_resource_harvests
WHERE node_id IN (
  SELECT id FROM repeatable_resource_nodes
);

-- Pre-reset stone IDs used the complete Population v2 plan identity, including
-- temporary non-stone lifecycle policy. There is no safe deterministic mapping
-- from those IDs to the corrected permanent-stone identity, so this test-server
-- reset removes the incompatible discoveries before their projections. The
-- existing node foreign key remains authoritative for every future discovery.
DELETE FROM player_discovered_mines;
COMMENT ON COLUMN player_discovered_mines.node_id IS
  'Stable permanent Population V2 stone entity identity backed by a current projection.';

DELETE FROM collectible_nodes;
DELETE FROM generated_world_mobs;
DELETE FROM repeatable_resource_nodes;

DELETE FROM population_runtime_entity_leases_v2;
DELETE FROM population_entity_state_v2;
DELETE FROM population_spawn_slots_v2;
DELETE FROM population_zone_cutover_operations_v2;
DELETE FROM population_zone_cutovers_v2;
DELETE FROM population_v2_rollout_audit;
DELETE FROM population_v2_rollout_control;
DELETE FROM population_zones_v2;

-- The old rollout selector and reversible cutover receipts have no meaning in
-- a V2-only runtime. The compact V2 authority row remains below.
DROP TABLE population_zone_cutover_operations_v2;
DROP TABLE population_v2_rollout_audit;
DROP TABLE population_v2_rollout_control;
DROP FUNCTION IF EXISTS reject_population_zone_cutover_operation_change_v2();
DROP FUNCTION IF EXISTS guard_population_v2_rollout_change();
DROP FUNCTION IF EXISTS prevent_population_v2_rollout_mutation();
DROP FUNCTION IF EXISTS population_v2_rollout_selection(uuid, text, text);
DROP FUNCTION IF EXISTS classify_v1_population_projection_cutover_v2();
DROP FUNCTION IF EXISTS reject_global_v1_population_insert_v2();

-- Remove the obsolete V1 population tables after detaching retained nullable
-- provenance columns. No V1 rows survive this point.
ALTER TABLE collectible_nodes
  DROP CONSTRAINT IF EXISTS collectible_nodes_source_population_area_id_fkey;
ALTER TABLE generated_world_mobs
  DROP CONSTRAINT IF EXISTS generated_world_mobs_source_population_area_id_fkey;
DO $$
DECLARE foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT conrelid::regclass AS relation_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'environmental_population_areas'::regclass
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      foreign_key.relation_name,
      foreign_key.conname
    );
  END LOOP;
END $$;
DROP TABLE IF EXISTS generated_resource_wolves;
DROP TABLE IF EXISTS environmental_population_events;
DROP TABLE IF EXISTS environmental_population_areas;
DROP TABLE IF EXISTS flag_resource_spawn_events;
DROP TABLE IF EXISTS flag_resource_spawn_allowances;
DROP FUNCTION IF EXISTS protect_current_generated_wolf();

-- Population projections are V2-owned only. Remove obsolete V1 provenance
-- columns after their parent tables and classifier triggers are gone.
ALTER TABLE collectible_nodes
  DROP CONSTRAINT IF EXISTS collectible_nodes_flag_generation_complete;
ALTER TABLE generated_world_mobs
  DROP CONSTRAINT IF EXISTS generated_world_mobs_population_owner_complete;

ALTER TABLE collectible_nodes
  DROP COLUMN source_flag_id,
  DROP COLUMN source_population_area_id,
  DROP COLUMN source_generation;
ALTER TABLE generated_world_mobs
  DROP COLUMN source_population_area_id,
  DROP COLUMN source_generation;

ALTER TABLE collectible_nodes
  ADD CONSTRAINT collectible_nodes_population_v2_owner_complete CHECK (
    placement_version IS NOT NULL
    AND resource_type = 'wood'
    AND quantity = 4
    AND population_v2_entity_id IS NOT NULL
    AND id = population_v2_entity_id::text
    AND population_v2_plan_id IS NOT NULL
    AND population_v2_state_revision IS NOT NULL
    AND physical_population_zone_v2_id IS NOT NULL
    AND population_cutover_revision IS NOT NULL
  );

ALTER TABLE generated_world_mobs
  ADD CONSTRAINT generated_world_mobs_population_owner_complete CHECK (
    population_v2_entity_id IS NOT NULL
    AND entity_id = population_v2_entity_id::text
    AND population_v2_plan_id IS NOT NULL
    AND population_v2_state_revision IS NOT NULL
    AND physical_population_zone_v2_id IS NOT NULL
    AND population_cutover_revision IS NOT NULL
  );

ALTER TABLE repeatable_resource_nodes
  DROP CONSTRAINT IF EXISTS repeatable_resource_nodes_population_v2_owner_complete,
  ADD CONSTRAINT repeatable_resource_nodes_population_v2_owner_complete CHECK (
    population_v2_entity_id IS NOT NULL
    AND id = population_v2_entity_id
    AND population_v2_plan_id IS NOT NULL
    AND population_v2_state_revision IS NOT NULL
    AND physical_population_zone_v2_id IS NOT NULL
    AND population_cutover_revision IS NOT NULL
    AND node_type = 'stone_mine'
    AND authored_source = 'population-v2'
  );

CREATE OR REPLACE FUNCTION protect_current_generated_tree()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_authorized boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.lat IS DISTINCT FROM OLD.lat
    OR NEW.lon IS DISTINCT FROM OLD.lon
    OR NEW.geom IS DISTINCT FROM OLD.geom
    OR NEW.placement_version IS DISTINCT FROM OLD.placement_version
    OR NEW.population_v2_entity_id IS DISTINCT FROM OLD.population_v2_entity_id
    OR NEW.population_v2_plan_id IS DISTINCT FROM OLD.population_v2_plan_id
    OR NEW.physical_population_zone_v2_id IS DISTINCT FROM OLD.physical_population_zone_v2_id
  THEN
    RAISE EXCEPTION 'population v2 tree identity, placement, and ownership are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'collectible_nodes_population_v2_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    OR NEW.harvested_at IS DISTINCT FROM OLD.harvested_at
    OR NEW.harvested_by_player_id IS DISTINCT FROM OLD.harvested_by_player_id
    OR NEW.population_v2_state_revision IS DISTINCT FROM OLD.population_v2_state_revision
  THEN
    SELECT EXISTS (
      SELECT 1 FROM population_entity_state_v2 AS state
      WHERE state.entity_id = NEW.population_v2_entity_id
        AND state.state_revision = NEW.population_v2_state_revision
        AND (
          (state.state = 'ready' AND NEW.state = 'available'
            AND NEW.harvested_at IS NULL
            AND NEW.harvested_by_player_id IS NULL)
          OR
          (state.state = 'harvested' AND NEW.state = 'harvested'
            AND NEW.harvested_at = state.killed_or_harvested_at
            AND NEW.harvested_by_player_id
              IS NOT DISTINCT FROM state.state_actor_player_id)
        )
    ) INTO state_authorized;
    IF NOT state_authorized THEN
      RAISE EXCEPTION 'population v2 tree state must follow canonical revision'
        USING ERRCODE = '23514',
              CONSTRAINT = 'collectible_nodes_population_v2_state_authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_generated_world_mob()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_authorized boolean;
BEGIN
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.mob_archetype IS DISTINCT FROM OLD.mob_archetype
    OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
    OR NEW.spawn_cell_id IS DISTINCT FROM OLD.spawn_cell_id
    OR NEW.region_code IS DISTINCT FROM OLD.region_code
    OR NEW.lat IS DISTINCT FROM OLD.lat
    OR NEW.lon IS DISTINCT FROM OLD.lon
    OR NEW.geom IS DISTINCT FROM OLD.geom
    OR NEW.anchor_lat IS DISTINCT FROM OLD.anchor_lat
    OR NEW.anchor_lon IS DISTINCT FROM OLD.anchor_lon
    OR NEW.placement_version IS DISTINCT FROM OLD.placement_version
    OR NEW.environment_world_identity_key
      IS DISTINCT FROM OLD.environment_world_identity_key
    OR NEW.environment_profile_version
      IS DISTINCT FROM OLD.environment_profile_version
    OR NEW.environment_candidate_slot_version
      IS DISTINCT FROM OLD.environment_candidate_slot_version
    OR NEW.environment_cell_id IS DISTINCT FROM OLD.environment_cell_id
    OR NEW.environment_slot_id IS DISTINCT FROM OLD.environment_slot_id
    OR NEW.environment_snapshot IS DISTINCT FROM OLD.environment_snapshot
    OR NEW.population_v2_entity_id
      IS DISTINCT FROM OLD.population_v2_entity_id
    OR NEW.population_v2_plan_id IS DISTINCT FROM OLD.population_v2_plan_id
    OR NEW.physical_population_zone_v2_id
      IS DISTINCT FROM OLD.physical_population_zone_v2_id
  THEN
    RAISE EXCEPTION 'population v2 mob identity, encounter, placement, environment, and ownership are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_world_mobs_current_immutable';
  END IF;

  IF NEW.killed_at IS DISTINCT FROM OLD.killed_at
    OR NEW.killed_by_player_id IS DISTINCT FROM OLD.killed_by_player_id
    OR NEW.population_v2_state_revision
      IS DISTINCT FROM OLD.population_v2_state_revision
  THEN
    SELECT EXISTS (
      SELECT 1 FROM population_entity_state_v2 AS state
      WHERE state.entity_id = NEW.population_v2_entity_id
        AND state.state_revision = NEW.population_v2_state_revision
        AND (
          (state.state = 'ready' AND NEW.killed_at IS NULL
            AND NEW.killed_by_player_id IS NULL)
          OR
          (state.state = 'dead'
            AND NEW.killed_at = state.killed_or_harvested_at
            AND NEW.killed_by_player_id
              IS NOT DISTINCT FROM state.state_actor_player_id)
        )
    ) INTO state_authorized;
    IF NOT state_authorized THEN
      RAISE EXCEPTION 'population v2 mob state must follow canonical revision'
        USING ERRCODE = '23514',
              CONSTRAINT = 'generated_world_mobs_population_v2_state_authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_permanent_mine_placement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_authorized boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.lat IS DISTINCT FROM OLD.lat
    OR NEW.lon IS DISTINCT FROM OLD.lon
    OR NEW.geom IS DISTINCT FROM OLD.geom
    OR NEW.placement_bucket_key IS DISTINCT FROM OLD.placement_bucket_key
    OR NEW.placement_version IS DISTINCT FROM OLD.placement_version
    OR NEW.authored_source IS DISTINCT FROM OLD.authored_source
    OR NEW.population_v2_entity_id IS DISTINCT FROM OLD.population_v2_entity_id
    OR NEW.population_v2_plan_id IS DISTINCT FROM OLD.population_v2_plan_id
    OR NEW.physical_population_zone_v2_id
      IS DISTINCT FROM OLD.physical_population_zone_v2_id
  THEN
    RAISE EXCEPTION 'population v2 stone identity and placement are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'repeatable_resource_nodes_population_v2_immutable';
  END IF;
  IF NEW.ready_at IS DISTINCT FROM OLD.ready_at
    OR NEW.harvest_revision IS DISTINCT FROM OLD.harvest_revision
    OR NEW.last_harvested_by IS DISTINCT FROM OLD.last_harvested_by
    OR NEW.population_v2_state_revision
      IS DISTINCT FROM OLD.population_v2_state_revision
  THEN
    SELECT EXISTS (
      SELECT 1 FROM population_entity_state_v2 AS state
      WHERE state.entity_id = NEW.population_v2_entity_id
        AND state.state_revision = NEW.population_v2_state_revision
        AND NEW.harvest_revision = state.state_revision
        AND (
          (
            state.state = 'ready'
            AND NEW.ready_at = '-infinity'::timestamptz
            AND NEW.last_harvested_by IS NULL
          )
          OR
          (
            state.state = 'harvested'
            AND NEW.ready_at = state.respawn_at
            AND NEW.last_harvested_by
              IS NOT DISTINCT FROM state.state_actor_player_id
          )
        )
    ) INTO state_authorized;
    IF NOT state_authorized THEN
      RAISE EXCEPTION 'population v2 stone state must follow canonical revision'
        USING ERRCODE = '23514',
              CONSTRAINT =
                'repeatable_resource_nodes_population_v2_state_authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A ready plan is immutable habitat/template authority. Candidate sites and
-- non-stone templates are data, not live entities and do not start a timer.
ALTER TABLE population_zones_v2
  ADD COLUMN habitat_snapshot jsonb NULL
    CHECK (
      habitat_snapshot IS NULL
      OR jsonb_typeof(habitat_snapshot) = 'object'
    ),
  ADD COLUMN candidate_pool jsonb NULL
    CHECK (
      candidate_pool IS NULL
      OR jsonb_typeof(candidate_pool) = 'array'
    ),
  ADD COLUMN nonstone_template_slots jsonb NULL
    CHECK (
      nonstone_template_slots IS NULL
      OR jsonb_typeof(nonstone_template_slots) = 'array'
    ),
  ADD CONSTRAINT population_zones_v2_ready_template_complete CHECK (
    status <> 'ready'
    OR (
      habitat_snapshot IS NOT NULL
      AND candidate_pool IS NOT NULL
      AND nonstone_template_slots IS NOT NULL
    )
  );

CREATE TABLE population_zone_generations_v2 (
  generation_id uuid PRIMARY KEY,
  zone_id text NOT NULL CHECK (zone_id <> ''),
  plan_id uuid NOT NULL REFERENCES population_zones_v2(plan_id)
    ON DELETE RESTRICT,
  generation_number bigint NOT NULL CHECK (generation_number > 0),
  generated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (
    status IN ('active', 'expired', 'refresh-pending')
  ),
  planned_nonstone_count integer NOT NULL
    CHECK (planned_nonstone_count >= 0),
  current_reference_count integer NOT NULL DEFAULT 0
    CHECK (current_reference_count >= 0),
  unreferenced_at timestamptz NULL,
  is_current boolean NOT NULL DEFAULT true,
  cleaned_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (zone_id, generation_number),
  UNIQUE (generation_id, plan_id),
  CHECK (expires_at = generated_at + interval '48 hours'),
  CHECK (current_reference_count = 0 OR unreferenced_at IS NULL),
  CHECK (
    (is_current AND cleaned_at IS NULL)
    OR
    (
      NOT is_current
      AND status = 'expired'
      AND cleaned_at IS NOT NULL
      AND current_reference_count = 0
    )
  )
);

CREATE UNIQUE INDEX population_zone_generations_v2_one_current_idx
  ON population_zone_generations_v2 (zone_id)
  WHERE is_current;
CREATE INDEX population_zone_generations_v2_expiry_idx
  ON population_zone_generations_v2 (expires_at, zone_id)
  WHERE is_current;

ALTER TABLE population_spawn_slots_v2
  ADD COLUMN generation_id uuid NULL,
  ADD CONSTRAINT population_spawn_slots_v2_generation_plan_fk
    FOREIGN KEY (generation_id, plan_id)
    REFERENCES population_zone_generations_v2(generation_id, plan_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT population_spawn_slots_v2_lifecycle_shape CHECK (
    (entity_kind = 'stone' AND generation_id IS NULL)
    OR
    (entity_kind <> 'stone' AND generation_id IS NOT NULL)
  );

CREATE INDEX population_spawn_slots_v2_generation_idx
  ON population_spawn_slots_v2 (generation_id, entity_kind, entity_id)
  WHERE generation_id IS NOT NULL;

-- Non-stone death/harvest state lasts for the generation and therefore has no
-- per-entity respawn timestamp. Permanent stone keeps its independent 5h50m
-- regeneration lifecycle.
ALTER TABLE population_entity_state_v2
  DROP CONSTRAINT IF EXISTS population_entity_state_v2_check;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'population_entity_state_v2'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%respawn_at%'
      AND pg_get_constraintdef(oid) LIKE '%killed_or_harvested_at%'
  LOOP
    EXECUTE format(
      'ALTER TABLE population_entity_state_v2 DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE population_entity_state_v2
  ADD CONSTRAINT population_entity_state_v2_event_shape CHECK (
    (
      state = 'ready'
      AND state_actor_player_id IS NULL
      AND killed_or_harvested_at IS NULL
      AND respawn_at IS NULL
    )
    OR
    (
      state IN ('dead', 'harvested')
      AND killed_or_harvested_at IS NOT NULL
      AND (
        respawn_at IS NULL
        OR respawn_at >= killed_or_harvested_at
      )
    )
  );

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'generated_world_mobs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%killed_at%'
      AND pg_get_constraintdef(oid) LIKE '%killed_by_player_id%'
  LOOP
    EXECUTE format(
      'ALTER TABLE generated_world_mobs DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE generated_world_mobs
  ADD CONSTRAINT generated_world_mobs_death_actor_shape CHECK (
    killed_at IS NOT NULL OR killed_by_player_id IS NULL
  );

CREATE OR REPLACE FUNCTION validate_population_entity_lifecycle_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slot_kind text;
BEGIN
  SELECT entity_kind INTO STRICT slot_kind
  FROM population_spawn_slots_v2
  WHERE entity_id = NEW.entity_id;

  IF NEW.state = 'ready' THEN
    RETURN NEW;
  END IF;
  IF slot_kind = 'stone' THEN
    IF NEW.respawn_at IS DISTINCT FROM
      NEW.killed_or_harvested_at + interval '5 hours 50 minutes'
    THEN
      RAISE EXCEPTION 'stone regeneration must be exactly 5 hours 50 minutes'
        USING ERRCODE = '23514',
              CONSTRAINT = 'population_entity_state_v2_stone_regeneration';
    END IF;
  ELSIF NEW.respawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'non-stone generation entities never individually respawn'
      USING ERRCODE = '23514',
            CONSTRAINT = 'population_entity_state_v2_nonstone_no_respawn';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_entity_state_v2_validate_lifecycle
BEFORE INSERT OR UPDATE OF state, killed_or_harvested_at, respawn_at
ON population_entity_state_v2
FOR EACH ROW EXECUTE FUNCTION validate_population_entity_lifecycle_v2();

-- Enforce the intended permanent-mine interval for every future writer.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'repeatable_resource_nodes'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%node_type%'
      AND pg_get_constraintdef(oid) LIKE '%regeneration_interval%'
  LOOP
    EXECUTE format(
      'ALTER TABLE repeatable_resource_nodes DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE repeatable_resource_nodes
  ADD CONSTRAINT repeatable_resource_nodes_stone_mine_interval_check
  CHECK (
    regeneration_interval = interval '5 hours 50 minutes'
  );

-- The serving authority is V2-only. It retains a revision because combat and
-- runtime leases use it as a fencing token, never as a V1/V2 selector.
ALTER TABLE population_zone_cutovers_v2
  DROP CONSTRAINT IF EXISTS population_zone_cutovers_v2_serving_version_check,
  DROP CONSTRAINT IF EXISTS population_zone_cutovers_v2_check;
ALTER TABLE population_zone_cutovers_v2
  ADD CONSTRAINT population_zone_cutovers_v2_v2_only CHECK (
    serving_version = 'v2' AND selected_plan_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION protect_population_zone_v2_ready_plan()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'ready' THEN
    RAISE EXCEPTION 'ready population v2 plans are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'population_zones_v2_ready_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'ready' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ready population v2 plans are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'population_zones_v2_ready_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_zones_v2_protect_ready
BEFORE UPDATE OR DELETE ON population_zones_v2
FOR EACH ROW EXECUTE FUNCTION protect_population_zone_v2_ready_plan();

CREATE OR REPLACE FUNCTION protect_population_spawn_slot_v2_ready_plan()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_plan_id uuid :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_id ELSE NEW.plan_id END;
  target_generation_id uuid :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.generation_id ELSE NEW.generation_id END;
  target_status text;
  generation_status text;
  generation_current boolean;
BEGIN
  SELECT status INTO target_status
  FROM population_zones_v2
  WHERE plan_id = target_plan_id;
  IF target_status <> 'ready' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND target_generation_id IS NOT NULL THEN
    SELECT status, is_current
    INTO generation_status, generation_current
    FROM population_zone_generations_v2
    WHERE generation_id = target_generation_id
      AND plan_id = target_plan_id;
    IF generation_status = 'active' AND generation_current THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' AND target_generation_id IS NOT NULL THEN
    SELECT status INTO generation_status
    FROM population_zone_generations_v2
    WHERE generation_id = target_generation_id
      AND plan_id = target_plan_id;
    IF generation_status IN ('expired', 'refresh-pending') THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'slots of ready population v2 plans are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'population_spawn_slots_v2_ready_immutable';
END;
$$;

CREATE TRIGGER population_spawn_slots_v2_protect_ready
BEFORE INSERT OR UPDATE OR DELETE ON population_spawn_slots_v2
FOR EACH ROW EXECUTE FUNCTION protect_population_spawn_slot_v2_ready_plan();

CREATE OR REPLACE FUNCTION enforce_population_generation_cap_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  generation uuid :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.generation_id ELSE NEW.generation_id END;
  planned integer;
  actual integer;
BEGIN
  IF generation IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT planned_nonstone_count INTO planned
  FROM population_zone_generations_v2
  WHERE generation_id = generation;
  SELECT count(*) INTO actual
  FROM population_spawn_slots_v2
  WHERE generation_id = generation;
  IF actual > planned THEN
    RAISE EXCEPTION 'population generation exceeds its planned population'
      USING ERRCODE = '23514',
            CONSTRAINT = 'population_zone_generations_v2_planned_cap';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER population_spawn_slots_v2_enforce_generation_cap
AFTER INSERT OR UPDATE OR DELETE ON population_spawn_slots_v2
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_population_generation_cap_v2();

COMMENT ON TABLE population_zones_v2 IS
  'Immutable Population v2 habitat, candidate-pool, and template authority.';
COMMENT ON TABLE population_zone_generations_v2 IS
  'Minimal 48-hour non-stone generation lifecycle metadata; cleaned rows retain diagnostics only.';
COMMENT ON COLUMN population_spawn_slots_v2.generation_id IS
  'NULL only for permanent stone; non-stone slots are scoped to one temporary generation.';
