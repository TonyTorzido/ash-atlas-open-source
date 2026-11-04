-- Durable, versioned, seam-safe population ownership and runtime fencing.
-- World runtime SHA is retained as provenance but is deliberately excluded
-- from the stable World-environment identity and plan uniqueness key.

CREATE TABLE population_zones_v2 (
  plan_id uuid PRIMARY KEY,
  zone_id text NOT NULL CHECK (zone_id <> ''),
  geometry_version text NOT NULL CHECK (geometry_version <> ''),
  world_environment_identity_key text NOT NULL
    CHECK (world_environment_identity_key ~ '^[a-f0-9]{64}$'),
  world_runtime_sha text NOT NULL
    CHECK (world_runtime_sha ~ '^[a-f0-9]{40}$'),
  plan_version text NOT NULL CHECK (plan_version <> ''),
  spawn_rules_version text NOT NULL CHECK (spawn_rules_version <> ''),
  environment_profile_version text NOT NULL
    CHECK (environment_profile_version <> ''),
  candidate_layout_version text NOT NULL
    CHECK (candidate_layout_version <> ''),
  respawn_policy_version text NOT NULL
    CHECK (respawn_policy_version <> ''),
  content_hash text NULL CHECK (
    content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'
  ),
  region_code text NOT NULL CHECK (region_code <> ''),
  band_index integer NOT NULL CHECK (band_index >= 0),
  column_index integer NOT NULL CHECK (column_index >= 0),
  zone_geog geography(MultiPolygon, 4326) NOT NULL,
  center_geog geography(Point, 4326) NOT NULL,
  total_area_km2 double precision NOT NULL CHECK (total_area_km2 > 0),
  eligible_land_km2 double precision NOT NULL DEFAULT 0,
  tree_km2 double precision NOT NULL DEFAULT 0,
  deer_km2 double precision NOT NULL DEFAULT 0,
  wolf_km2 double precision NOT NULL DEFAULT 0,
  ogre_km2 double precision NOT NULL DEFAULT 0,
  stone_km2 double precision NOT NULL DEFAULT 0,
  habitat_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(habitat_summary) = 'object'),
  status text NOT NULL CHECK (status IN (
    'pending', 'generating', 'ready',
    'retryable-failure', 'terminal-failure'
  )),
  claim_owner_id uuid NULL,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  lease_expires_at timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (
    attempt_count >= 0 AND attempt_count <= 8
  ),
  next_retry_at timestamptz NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz NULL,
  UNIQUE (
    zone_id,
    geometry_version,
    world_environment_identity_key,
    plan_version,
    spawn_rules_version,
    environment_profile_version,
    candidate_layout_version,
    respawn_policy_version
  ),
  UNIQUE (plan_id, zone_id, geometry_version),
  CHECK (
    eligible_land_km2 BETWEEN 0 AND total_area_km2
    AND tree_km2 BETWEEN 0 AND total_area_km2
    AND deer_km2 BETWEEN 0 AND total_area_km2
    AND wolf_km2 BETWEEN 0 AND total_area_km2
    AND ogre_km2 BETWEEN 0 AND total_area_km2
    AND stone_km2 BETWEEN 0 AND total_area_km2
  ),
  CHECK (
    (status = 'generating'
      AND claim_owner_id IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'generating'
      AND claim_owner_id IS NULL
      AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('pending', 'retryable-failure') AND next_retry_at IS NOT NULL)
    OR
    (status IN ('generating', 'ready', 'terminal-failure')
      AND next_retry_at IS NULL)
  ),
  CHECK (
    (status = 'ready' AND ready_at IS NOT NULL AND content_hash IS NOT NULL)
    OR
    (status <> 'ready' AND ready_at IS NULL AND content_hash IS NULL)
  )
);

CREATE INDEX population_zones_v2_zone_geog_idx
  ON population_zones_v2 USING gist (zone_geog);
CREATE INDEX population_zones_v2_center_geog_idx
  ON population_zones_v2 USING gist (center_geog);
CREATE INDEX population_zones_v2_claimable_idx
  ON population_zones_v2 (next_retry_at, created_at, plan_id)
  WHERE status IN ('pending', 'retryable-failure');
CREATE INDEX population_zones_v2_expired_claim_idx
  ON population_zones_v2 (lease_expires_at, plan_id)
  WHERE status = 'generating';

CREATE TABLE population_spawn_slots_v2 (
  plan_id uuid NOT NULL
    REFERENCES population_zones_v2(plan_id) ON DELETE RESTRICT,
  slot_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  candidate_id text NOT NULL CHECK (candidate_id <> ''),
  entity_kind text NOT NULL
    CHECK (entity_kind IN ('tree', 'deer', 'wolf', 'ogre', 'stone')),
  archetype text NOT NULL CHECK (archetype <> ''),
  encounter_id uuid NULL,
  pack_id uuid NULL,
  pack_member_index smallint NULL CHECK (pack_member_index >= 0),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  geom geography(Point, 4326) NOT NULL,
  anchor_latitude double precision NOT NULL
    CHECK (anchor_latitude BETWEEN -90 AND 90),
  anchor_longitude double precision NOT NULL
    CHECK (anchor_longitude BETWEEN -180 AND 180),
  anchor_geom geography(Point, 4326) NOT NULL,
  environment_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(environment_snapshot) = 'object'),
  suppression_class text NOT NULL CHECK (
    suppression_class IN ('none', 'deer-safe', 'hostile-pack', 'hostile-ogre')
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plan_id, slot_id),
  UNIQUE (entity_id),
  UNIQUE (plan_id, entity_id),
  CHECK (
    (entity_kind = 'wolf'
      AND encounter_id IS NOT NULL
      AND pack_id IS NOT NULL
      AND pack_member_index IS NOT NULL)
    OR
    (entity_kind IN ('deer', 'ogre')
      AND encounter_id IS NOT NULL
      AND pack_id IS NULL
      AND pack_member_index IS NULL)
    OR
    (entity_kind IN ('tree', 'stone')
      AND encounter_id IS NULL
      AND pack_id IS NULL
      AND pack_member_index IS NULL)
  )
);

CREATE INDEX population_spawn_slots_v2_geom_idx
  ON population_spawn_slots_v2 USING gist (geom);
CREATE INDEX population_spawn_slots_v2_anchor_geom_idx
  ON population_spawn_slots_v2 USING gist (anchor_geom);
CREATE INDEX population_spawn_slots_v2_plan_kind_idx
  ON population_spawn_slots_v2 (plan_id, entity_kind, entity_id);

CREATE TABLE population_entity_state_v2 (
  entity_id uuid PRIMARY KEY
    REFERENCES population_spawn_slots_v2(entity_id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('ready', 'dead', 'harvested')),
  state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  state_actor_player_id text NULL REFERENCES players(id) ON DELETE SET NULL,
  killed_or_harvested_at timestamptz NULL,
  respawn_at timestamptz NULL,
  durable_runtime_state jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(durable_runtime_state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state = 'ready'
      AND state_actor_player_id IS NULL
      AND killed_or_harvested_at IS NULL
      AND respawn_at IS NULL)
    OR
    (state IN ('dead', 'harvested')
      AND killed_or_harvested_at IS NOT NULL
      AND respawn_at IS NOT NULL
      AND respawn_at >= killed_or_harvested_at)
  )
);

CREATE INDEX population_entity_state_v2_respawn_idx
  ON population_entity_state_v2 (respawn_at, entity_id)
  WHERE state IN ('dead', 'harvested');

CREATE TABLE population_zone_cutovers_v2 (
  zone_id text NOT NULL,
  geometry_version text NOT NULL,
  serving_version text NOT NULL CHECK (serving_version IN ('v1', 'v2')),
  selected_plan_id uuid NULL,
  cutover_revision bigint NOT NULL CHECK (cutover_revision > 0),
  status text NOT NULL CHECK (status IN ('stable', 'switching')),
  authorized_by_account_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (zone_id, geometry_version),
  FOREIGN KEY (selected_plan_id, zone_id, geometry_version)
    REFERENCES population_zones_v2(plan_id, zone_id, geometry_version)
    ON DELETE RESTRICT,
  CHECK (
    (serving_version = 'v2' AND selected_plan_id IS NOT NULL)
    OR
    (serving_version = 'v1' AND selected_plan_id IS NULL)
  )
);

CREATE INDEX population_zone_cutovers_v2_serving_idx
  ON population_zone_cutovers_v2 (serving_version, updated_at, zone_id);

CREATE TABLE population_zone_cutover_operations_v2 (
  operation_id uuid PRIMARY KEY,
  zone_id text NOT NULL,
  geometry_version text NOT NULL,
  action text NOT NULL CHECK (action IN ('cutover', 'rollback')),
  selected_plan_id uuid NULL,
  authorized_by_account_id text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (zone_id, geometry_version)
    REFERENCES population_zone_cutovers_v2(zone_id, geometry_version)
    ON DELETE RESTRICT,
  FOREIGN KEY (selected_plan_id, zone_id, geometry_version)
    REFERENCES population_zones_v2(plan_id, zone_id, geometry_version)
    ON DELETE RESTRICT,
  CHECK (
    (action = 'cutover' AND selected_plan_id IS NOT NULL)
    OR
    (action = 'rollback' AND selected_plan_id IS NULL)
  )
);

CREATE INDEX population_zone_cutover_operations_v2_zone_idx
  ON population_zone_cutover_operations_v2 (zone_id, created_at);

CREATE OR REPLACE FUNCTION reject_population_zone_cutover_operation_change_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'population zone cutover operation receipts are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'population_zone_cutover_operations_v2_immutable';
END;
$$;

CREATE TRIGGER population_zone_cutover_operations_v2_reject_change
BEFORE UPDATE OR DELETE ON population_zone_cutover_operations_v2
FOR EACH ROW EXECUTE FUNCTION reject_population_zone_cutover_operation_change_v2();

CREATE TABLE population_runtime_entity_leases_v2 (
  entity_id uuid PRIMARY KEY
    REFERENCES population_spawn_slots_v2(entity_id) ON DELETE RESTRICT,
  runtime_id text NOT NULL CHECK (runtime_id <> ''),
  owner_token uuid NOT NULL UNIQUE,
  fencing_generation bigint NOT NULL CHECK (fencing_generation > 0),
  cutover_revision bigint NOT NULL CHECK (cutover_revision > 0),
  state_revision bigint NOT NULL CHECK (state_revision >= 0),
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL
);

CREATE INDEX population_runtime_entity_leases_v2_expiry_idx
  ON population_runtime_entity_leases_v2 (lease_expires_at, entity_id);

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
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_zones_v2_protect_ready
BEFORE UPDATE OR DELETE ON population_zones_v2
FOR EACH ROW EXECUTE FUNCTION protect_population_zone_v2_ready_plan();

CREATE OR REPLACE FUNCTION protect_population_spawn_slot_v2_ready_plan()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_id ELSE NEW.plan_id END;
  target_status text;
BEGIN
  SELECT status INTO target_status
  FROM population_zones_v2
  WHERE plan_id = target_plan_id;
  IF target_status = 'ready' THEN
    RAISE EXCEPTION 'slots of ready population v2 plans are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'population_spawn_slots_v2_ready_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_spawn_slots_v2_protect_ready
BEFORE INSERT OR UPDATE OR DELETE ON population_spawn_slots_v2
FOR EACH ROW EXECUTE FUNCTION protect_population_spawn_slot_v2_ready_plan();

ALTER TABLE collectible_nodes
  ADD COLUMN population_v2_entity_id uuid NULL,
  ADD COLUMN physical_population_zone_v2_id text NULL,
  ADD COLUMN population_v2_plan_id uuid NULL,
  ADD COLUMN population_v2_state_revision bigint NULL
    CHECK (population_v2_state_revision >= 0),
  ADD COLUMN population_cutover_revision bigint NULL
    CHECK (population_cutover_revision > 0),
  ADD COLUMN population_cutover_suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN population_flag_suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN population_v2_suppressed boolean GENERATED ALWAYS AS (
    population_cutover_suppressed OR population_flag_suppressed
  ) STORED;

ALTER TABLE collectible_nodes
  DROP CONSTRAINT IF EXISTS collectible_nodes_flag_generation_complete,
  ADD CONSTRAINT collectible_nodes_flag_generation_complete CHECK (
    (source_flag_id IS NULL AND source_population_area_id IS NULL
      AND source_generation IS NULL AND placement_version IS NULL
      AND population_v2_entity_id IS NULL AND population_v2_plan_id IS NULL
      AND population_v2_state_revision IS NULL)
    OR
    (source_flag_id IS NOT NULL AND source_population_area_id IS NULL
      AND source_generation > 0 AND placement_version IS NOT NULL
      AND resource_type = 'wood' AND quantity = 4
      AND population_v2_entity_id IS NULL AND population_v2_plan_id IS NULL
      AND population_v2_state_revision IS NULL)
    OR
    (source_flag_id IS NULL AND source_population_area_id IS NOT NULL
      AND source_generation > 0 AND placement_version IS NOT NULL
      AND resource_type = 'wood' AND quantity = 4
      AND population_v2_entity_id IS NULL AND population_v2_plan_id IS NULL
      AND population_v2_state_revision IS NULL)
    OR
    (source_flag_id IS NULL AND source_population_area_id IS NULL
      AND source_generation IS NULL AND placement_version IS NOT NULL
      AND resource_type = 'wood' AND quantity = 4
      AND population_v2_entity_id IS NOT NULL
      AND population_v2_plan_id IS NOT NULL
      AND population_v2_state_revision IS NOT NULL
      AND physical_population_zone_v2_id IS NOT NULL
      AND population_cutover_revision IS NOT NULL)
  ),
  ADD CONSTRAINT collectible_nodes_population_v2_classification_complete CHECK (
    (physical_population_zone_v2_id IS NULL AND population_cutover_revision IS NULL)
    OR
    (physical_population_zone_v2_id IS NOT NULL
      AND population_cutover_revision IS NOT NULL)
  ),
  ADD CONSTRAINT collectible_nodes_population_v2_slot_fk
    FOREIGN KEY (population_v2_plan_id, population_v2_entity_id)
    REFERENCES population_spawn_slots_v2(plan_id, entity_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX collectible_nodes_population_v2_entity_idx
  ON collectible_nodes (population_v2_entity_id)
  WHERE population_v2_entity_id IS NOT NULL;
CREATE INDEX collectible_nodes_population_v2_visible_idx
  ON collectible_nodes (
    physical_population_zone_v2_id,
    population_cutover_revision,
    population_v2_plan_id
  )
  WHERE NOT population_v2_suppressed;

ALTER TABLE generated_world_mobs
  ALTER COLUMN source_population_area_id DROP NOT NULL,
  ALTER COLUMN source_generation DROP NOT NULL,
  ADD COLUMN population_v2_entity_id uuid NULL,
  ADD COLUMN physical_population_zone_v2_id text NULL,
  ADD COLUMN population_v2_plan_id uuid NULL,
  ADD COLUMN population_v2_state_revision bigint NULL
    CHECK (population_v2_state_revision >= 0),
  ADD COLUMN population_cutover_revision bigint NULL
    CHECK (population_cutover_revision > 0),
  ADD COLUMN population_cutover_suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN population_flag_suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN population_v2_suppressed boolean GENERATED ALWAYS AS (
    population_cutover_suppressed OR population_flag_suppressed
  ) STORED;

ALTER TABLE generated_world_mobs
  ADD CONSTRAINT generated_world_mobs_population_owner_complete CHECK (
    (source_population_area_id IS NOT NULL AND source_generation IS NOT NULL
      AND population_v2_entity_id IS NULL AND population_v2_plan_id IS NULL
      AND population_v2_state_revision IS NULL)
    OR
    (source_population_area_id IS NULL AND source_generation IS NULL
      AND population_v2_entity_id IS NOT NULL
      AND population_v2_plan_id IS NOT NULL
      AND population_v2_state_revision IS NOT NULL
      AND physical_population_zone_v2_id IS NOT NULL
      AND population_cutover_revision IS NOT NULL)
  ),
  ADD CONSTRAINT generated_world_mobs_population_v2_classification_complete CHECK (
    (physical_population_zone_v2_id IS NULL AND population_cutover_revision IS NULL)
    OR
    (physical_population_zone_v2_id IS NOT NULL
      AND population_cutover_revision IS NOT NULL)
  ),
  ADD CONSTRAINT generated_world_mobs_population_v2_slot_fk
    FOREIGN KEY (population_v2_plan_id, population_v2_entity_id)
    REFERENCES population_spawn_slots_v2(plan_id, entity_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX generated_world_mobs_population_v2_entity_idx
  ON generated_world_mobs (population_v2_entity_id)
  WHERE population_v2_entity_id IS NOT NULL;
CREATE INDEX generated_world_mobs_population_v2_visible_idx
  ON generated_world_mobs (
    physical_population_zone_v2_id,
    population_cutover_revision,
    population_v2_plan_id
  )
  WHERE NOT population_v2_suppressed;

ALTER TABLE repeatable_resource_nodes
  ADD COLUMN population_v2_entity_id uuid NULL,
  ADD COLUMN physical_population_zone_v2_id text NULL,
  ADD COLUMN population_v2_plan_id uuid NULL,
  ADD COLUMN population_v2_state_revision bigint NULL
    CHECK (population_v2_state_revision >= 0),
  ADD COLUMN population_cutover_revision bigint NULL
    CHECK (population_cutover_revision > 0),
  ADD COLUMN population_cutover_suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN population_flag_suppressed boolean NOT NULL DEFAULT false,
  ADD COLUMN population_v2_suppressed boolean GENERATED ALWAYS AS (
    population_cutover_suppressed OR population_flag_suppressed
  ) STORED;

ALTER TABLE repeatable_resource_nodes
  ADD CONSTRAINT repeatable_resource_nodes_population_v2_owner_complete CHECK (
    (population_v2_entity_id IS NULL AND population_v2_plan_id IS NULL
      AND population_v2_state_revision IS NULL)
    OR
    (population_v2_entity_id IS NOT NULL
      AND population_v2_plan_id IS NOT NULL
      AND population_v2_state_revision IS NOT NULL
      AND physical_population_zone_v2_id IS NOT NULL
      AND population_cutover_revision IS NOT NULL
      AND node_type = 'stone_mine'
      AND authored_source = 'population-v2')
  ),
  ADD CONSTRAINT repeatable_resource_nodes_population_v2_classification_complete CHECK (
    (physical_population_zone_v2_id IS NULL AND population_cutover_revision IS NULL)
    OR
    (physical_population_zone_v2_id IS NOT NULL
      AND population_cutover_revision IS NOT NULL)
  ),
  ADD CONSTRAINT repeatable_resource_nodes_population_v2_slot_fk
    FOREIGN KEY (population_v2_plan_id, population_v2_entity_id)
    REFERENCES population_spawn_slots_v2(plan_id, entity_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX repeatable_resource_nodes_population_v2_entity_idx
  ON repeatable_resource_nodes (population_v2_entity_id)
  WHERE population_v2_entity_id IS NOT NULL;
CREATE INDEX repeatable_resource_nodes_population_v2_visible_idx
  ON repeatable_resource_nodes (
    physical_population_zone_v2_id,
    population_cutover_revision,
    population_v2_plan_id
  )
  WHERE NOT population_v2_suppressed;

CREATE OR REPLACE FUNCTION classify_v1_population_projection_cutover_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  generated_v1 boolean := false;
  selected_zone_id text;
  selected_revision bigint;
BEGIN
  IF NEW.population_v2_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'collectible_nodes' THEN
    generated_v1 := NEW.source_flag_id IS NOT NULL
      OR NEW.source_population_area_id IS NOT NULL;
  ELSIF TG_TABLE_NAME = 'generated_world_mobs' THEN
    generated_v1 := NEW.source_population_area_id IS NOT NULL;
  END IF;
  IF NOT generated_v1 THEN
    RETURN NEW;
  END IF;

  SELECT cutover.zone_id, cutover.cutover_revision
  INTO selected_zone_id, selected_revision
  FROM population_zone_cutovers_v2 AS cutover
  JOIN population_zones_v2 AS plan
    ON plan.plan_id = cutover.selected_plan_id
  WHERE cutover.serving_version = 'v2'
    AND ST_Covers(plan.zone_geog, NEW.geom::geography)
  ORDER BY cutover.cutover_revision DESC, cutover.zone_id
  LIMIT 1;

  IF selected_zone_id IS NULL THEN
    NEW.population_cutover_suppressed := false;
  ELSE
    NEW.physical_population_zone_v2_id := selected_zone_id;
    NEW.population_cutover_revision := selected_revision;
    NEW.population_cutover_suppressed := true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collectible_nodes_classify_v1_population_v2
BEFORE INSERT OR UPDATE OF geom, source_flag_id, source_population_area_id,
  population_cutover_suppressed
ON collectible_nodes
FOR EACH ROW EXECUTE FUNCTION classify_v1_population_projection_cutover_v2();

CREATE TRIGGER generated_world_mobs_classify_v1_population_v2
BEFORE INSERT OR UPDATE OF geom, source_population_area_id,
  population_cutover_suppressed
ON generated_world_mobs
FOR EACH ROW EXECUTE FUNCTION classify_v1_population_projection_cutover_v2();

DROP TRIGGER IF EXISTS collectible_nodes_protect_generated_resource
  ON collectible_nodes;
CREATE OR REPLACE FUNCTION protect_current_generated_tree()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_authorized boolean;
BEGIN
  IF OLD.population_v2_entity_id IS NOT NULL THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.lat IS DISTINCT FROM OLD.lat
      OR NEW.lon IS DISTINCT FROM OLD.lon
      OR NEW.geom IS DISTINCT FROM OLD.geom
      OR NEW.source_flag_id IS DISTINCT FROM OLD.source_flag_id
      OR NEW.source_population_area_id IS DISTINCT FROM OLD.source_population_area_id
      OR NEW.source_generation IS DISTINCT FROM OLD.source_generation
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
              AND NEW.harvested_by_player_id IS NOT DISTINCT FROM state.state_actor_player_id)
          )
      ) INTO state_authorized;
      IF NOT state_authorized THEN
        RAISE EXCEPTION 'population v2 tree state must follow canonical revision'
          USING ERRCODE = '23514',
                CONSTRAINT = 'collectible_nodes_population_v2_state_authority';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.source_flag_id IS NOT NULL OR OLD.source_population_area_id IS NOT NULL) AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.lat IS DISTINCT FROM OLD.lat OR
    NEW.lon IS DISTINCT FROM OLD.lon OR NEW.geom IS DISTINCT FROM OLD.geom OR
    NEW.source_flag_id IS DISTINCT FROM OLD.source_flag_id OR
    NEW.source_population_area_id IS DISTINCT FROM OLD.source_population_area_id OR
    NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
    NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
    (OLD.state = 'harvested' AND NEW.state <> 'harvested') OR
    (OLD.harvested_at IS NOT NULL AND NEW.harvested_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'current generated tree identity, placement, ownership, and consumption are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'collectible_nodes_current_generated_tree_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collectible_nodes_protect_generated_resource
BEFORE UPDATE ON collectible_nodes
FOR EACH ROW EXECUTE FUNCTION protect_current_generated_tree();

DROP TRIGGER IF EXISTS generated_world_mobs_protect_history
  ON generated_world_mobs;
CREATE OR REPLACE FUNCTION protect_generated_world_mob()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_authorized boolean;
BEGIN
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id OR
     NEW.encounter_id IS DISTINCT FROM OLD.encounter_id OR
     NEW.mob_archetype IS DISTINCT FROM OLD.mob_archetype OR
     NEW.pack_id IS DISTINCT FROM OLD.pack_id OR
     NEW.source_population_area_id IS DISTINCT FROM OLD.source_population_area_id OR
     NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
     NEW.spawn_cell_id IS DISTINCT FROM OLD.spawn_cell_id OR
     NEW.region_code IS DISTINCT FROM OLD.region_code OR
     NEW.lat IS DISTINCT FROM OLD.lat OR NEW.lon IS DISTINCT FROM OLD.lon OR
     NEW.geom IS DISTINCT FROM OLD.geom OR
     NEW.anchor_lat IS DISTINCT FROM OLD.anchor_lat OR
     NEW.anchor_lon IS DISTINCT FROM OLD.anchor_lon OR
     NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
     NEW.environment_world_identity_key IS DISTINCT FROM OLD.environment_world_identity_key OR
     NEW.environment_profile_version IS DISTINCT FROM OLD.environment_profile_version OR
     NEW.environment_candidate_slot_version IS DISTINCT FROM OLD.environment_candidate_slot_version OR
     NEW.environment_cell_id IS DISTINCT FROM OLD.environment_cell_id OR
     NEW.environment_slot_id IS DISTINCT FROM OLD.environment_slot_id OR
     NEW.environment_snapshot IS DISTINCT FROM OLD.environment_snapshot OR
     NEW.population_v2_entity_id IS DISTINCT FROM OLD.population_v2_entity_id OR
     NEW.population_v2_plan_id IS DISTINCT FROM OLD.population_v2_plan_id OR
     NEW.physical_population_zone_v2_id IS DISTINCT FROM OLD.physical_population_zone_v2_id
  THEN
    RAISE EXCEPTION 'generated world mob identity, encounter, placement, environment, and ownership are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_world_mobs_current_immutable';
  END IF;

  IF OLD.population_v2_entity_id IS NOT NULL AND (
    NEW.killed_at IS DISTINCT FROM OLD.killed_at OR
    NEW.killed_by_player_id IS DISTINCT FROM OLD.killed_by_player_id OR
    NEW.population_v2_state_revision IS DISTINCT FROM OLD.population_v2_state_revision
  ) THEN
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
            AND NEW.killed_by_player_id IS NOT DISTINCT FROM state.state_actor_player_id)
        )
    ) INTO state_authorized;
    IF NOT state_authorized THEN
      RAISE EXCEPTION 'population v2 mob state must follow canonical revision'
        USING ERRCODE = '23514',
              CONSTRAINT = 'generated_world_mobs_population_v2_state_authority';
    END IF;
  ELSIF OLD.population_v2_entity_id IS NULL AND (
    (OLD.killed_at IS NOT NULL AND NEW.killed_at IS NULL) OR
    (OLD.killed_by_player_id IS NOT NULL AND NEW.killed_by_player_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'generated world mob death is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'generated_world_mobs_current_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER generated_world_mobs_protect_history
BEFORE UPDATE ON generated_world_mobs
FOR EACH ROW EXECUTE FUNCTION protect_generated_world_mob();

DROP TRIGGER IF EXISTS repeatable_resource_nodes_protect_placement
  ON repeatable_resource_nodes;
CREATE OR REPLACE FUNCTION protect_permanent_mine_placement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_authorized boolean;
BEGIN
  IF OLD.population_v2_entity_id IS NOT NULL THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.lat IS DISTINCT FROM OLD.lat OR
       NEW.lon IS DISTINCT FROM OLD.lon OR
       NEW.geom IS DISTINCT FROM OLD.geom OR
       NEW.placement_bucket_key IS DISTINCT FROM OLD.placement_bucket_key OR
       NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
       NEW.authored_source IS DISTINCT FROM OLD.authored_source OR
       NEW.population_v2_entity_id IS DISTINCT FROM OLD.population_v2_entity_id OR
       NEW.population_v2_plan_id IS DISTINCT FROM OLD.population_v2_plan_id OR
       NEW.physical_population_zone_v2_id IS DISTINCT FROM OLD.physical_population_zone_v2_id
    THEN
      RAISE EXCEPTION 'population v2 stone identity and placement are immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'repeatable_resource_nodes_population_v2_immutable';
    END IF;
    IF NEW.ready_at IS DISTINCT FROM OLD.ready_at OR
       NEW.harvest_revision IS DISTINCT FROM OLD.harvest_revision OR
       NEW.last_harvested_by IS DISTINCT FROM OLD.last_harvested_by OR
       NEW.population_v2_state_revision IS DISTINCT FROM OLD.population_v2_state_revision
    THEN
      SELECT EXISTS (
        SELECT 1 FROM population_entity_state_v2 AS state
        WHERE state.entity_id = NEW.population_v2_entity_id
          AND state.state_revision = NEW.population_v2_state_revision
          AND NEW.harvest_revision = state.state_revision
          AND (
            (state.state = 'ready' AND NEW.ready_at = '-infinity'::timestamptz
              AND NEW.last_harvested_by IS NULL)
            OR
            (state.state = 'harvested' AND NEW.ready_at = state.respawn_at
              AND NEW.last_harvested_by IS NOT DISTINCT FROM state.state_actor_player_id)
          )
      ) INTO state_authorized;
      IF NOT state_authorized THEN
        RAISE EXCEPTION 'population v2 stone state must follow canonical revision'
          USING ERRCODE = '23514',
                CONSTRAINT = 'repeatable_resource_nodes_population_v2_state_authority';
      END IF;
    END IF;
  ELSIF OLD.placement_version <> 'authored-v1' AND (
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.lat IS DISTINCT FROM OLD.lat OR
    NEW.lon IS DISTINCT FROM OLD.lon OR
    NEW.geom IS DISTINCT FROM OLD.geom OR
    NEW.placement_bucket_key IS DISTINCT FROM OLD.placement_bucket_key OR
    NEW.placement_version IS DISTINCT FROM OLD.placement_version
  ) THEN
    RAISE EXCEPTION 'permanent mine placement is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'repeatable_resource_nodes_placement_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER repeatable_resource_nodes_protect_placement
BEFORE UPDATE ON repeatable_resource_nodes
FOR EACH ROW EXECUTE FUNCTION protect_permanent_mine_placement();

CREATE OR REPLACE FUNCTION synchronize_population_entity_state_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE collectible_nodes
  SET state = CASE WHEN NEW.state = 'ready' THEN 'available' ELSE 'harvested' END,
      harvested_at = CASE
        WHEN NEW.state = 'ready' THEN NULL
        ELSE NEW.killed_or_harvested_at
      END,
      harvested_by_player_id = CASE
        WHEN NEW.state = 'ready' THEN NULL
        ELSE NEW.state_actor_player_id
      END,
      population_v2_state_revision = NEW.state_revision
  WHERE population_v2_entity_id = NEW.entity_id;

  UPDATE generated_world_mobs
  SET killed_at = CASE
        WHEN NEW.state = 'ready' THEN NULL
        ELSE NEW.killed_or_harvested_at
      END,
      killed_by_player_id = CASE
        WHEN NEW.state = 'ready' THEN NULL
        ELSE NEW.state_actor_player_id
      END,
      population_v2_state_revision = NEW.state_revision
  WHERE population_v2_entity_id = NEW.entity_id;

  UPDATE repeatable_resource_nodes
  SET ready_at = CASE
        WHEN NEW.state = 'ready' THEN '-infinity'::timestamptz
        ELSE NEW.respawn_at
      END,
      harvest_revision = NEW.state_revision,
      last_harvested_by = CASE
        WHEN NEW.state = 'ready' THEN NULL
        ELSE NEW.state_actor_player_id
      END,
      population_v2_state_revision = NEW.state_revision
  WHERE population_v2_entity_id = NEW.entity_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_entity_state_v2_synchronize_projections
AFTER UPDATE OF state, state_revision, state_actor_player_id,
  killed_or_harvested_at, respawn_at
ON population_entity_state_v2
FOR EACH ROW EXECUTE FUNCTION synchronize_population_entity_state_v2();

COMMENT ON TABLE population_zones_v2 IS
  'Immutable ready population plans keyed by physical zone and stable World-data identity.';
COMMENT ON COLUMN population_zones_v2.world_runtime_sha IS
  'Build/runtime provenance only; excluded from the stable plan identity.';
COMMENT ON TABLE population_entity_state_v2 IS
  'Canonical durable life and harvest state for population v2 entities.';
COMMENT ON TABLE population_runtime_entity_leases_v2 IS
  'Crash-fencing leases for one authoritative game process; not cross-process actor affinity.';
