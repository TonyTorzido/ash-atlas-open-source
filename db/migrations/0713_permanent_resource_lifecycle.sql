-- Generalize permanent repeatable-resource authority without changing the
-- immutable stone authority recorded by migration 0678. Future permanent
-- resources extend these views instead of duplicating lifecycle queries.

CREATE VIEW population_permanent_resource_authority_v2 AS
SELECT authority.entity_id,
       authority.owner_zone_id,
       authority.entity_kind,
       authority.archetype AS node_type,
       'stone'::text AS yield_item_id,
       1::integer AS yield_quantity,
       interval '5 hours 50 minutes' AS regeneration_interval,
       'miner'::text AS timer_profession_id,
       2::integer AS timer_visibility_rank
FROM population_permanent_stone_authority_v2 AS authority;

CREATE VIEW population_plan_permanent_resources_v2 AS
SELECT membership.plan_id, membership.entity_id
FROM population_plan_permanent_stones_v2 AS membership;

COMMENT ON VIEW population_permanent_resource_authority_v2 IS
  'Immutable physical authority and lifecycle definition for every permanent repeatable resource.';
COMMENT ON VIEW population_plan_permanent_resources_v2 IS
  'Selected-plan membership for every permanent repeatable resource.';

CREATE OR REPLACE FUNCTION validate_population_entity_lifecycle_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  permanent_interval interval;
BEGIN
  SELECT authority.regeneration_interval
  INTO permanent_interval
  FROM population_permanent_resource_authority_v2 AS authority
  WHERE authority.entity_id=NEW.entity_id;

  IF permanent_interval IS NOT NULL THEN
    IF NEW.state = 'ready' THEN
      IF NEW.state_actor_player_id IS NOT NULL
        OR NEW.killed_or_harvested_at IS NOT NULL
        OR NEW.respawn_at IS NOT NULL
      THEN
        RAISE EXCEPTION
          'ready permanent resources cannot retain harvest lifecycle fields'
          USING ERRCODE = '23514',
                CONSTRAINT =
                  'population_entity_state_v2_permanent_resource_regeneration';
      END IF;
    ELSIF NEW.state <> 'harvested'
      OR NEW.killed_or_harvested_at IS NULL
      OR NEW.respawn_at IS NULL
      OR NEW.respawn_at IS DISTINCT FROM
        NEW.killed_or_harvested_at + permanent_interval
    THEN
      RAISE EXCEPTION
        'permanent-resource regeneration must match its registered interval'
        USING ERRCODE = '23514',
              CONSTRAINT =
                'population_entity_state_v2_permanent_resource_regeneration';
    END IF;
  ELSIF NEW.state = 'ready' THEN
    RETURN NEW;
  ELSIF NEW.respawn_at IS NOT NULL THEN
    RAISE EXCEPTION
      'non-permanent Population entities never individually respawn'
      USING ERRCODE = '23514',
            CONSTRAINT =
              'population_entity_state_v2_nonpermanent_no_respawn';
  END IF;
  RETURN NEW;
END;
$$;

-- Keep the general Population projection trigger focused on generated trees
-- and runtime mobs. Permanent repeatable resources have their own lifecycle
-- synchronizer below.
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
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION synchronize_permanent_resource_projection_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE repeatable_resource_nodes AS projection
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
  FROM population_permanent_resource_authority_v2 AS authority,
       population_zone_cutovers_v2 AS cutover,
       population_plan_permanent_resources_v2 AS membership
  WHERE authority.entity_id = NEW.entity_id
    AND projection.population_v2_entity_id = authority.entity_id
    AND authority.owner_zone_id =
        projection.physical_population_zone_v2_id
    AND projection.node_type = authority.node_type
    AND projection.yield_item_id = authority.yield_item_id
    AND projection.yield_quantity = authority.yield_quantity
    AND projection.regeneration_interval = authority.regeneration_interval
    AND cutover.zone_id = authority.owner_zone_id
    AND cutover.status = 'stable'
    AND cutover.serving_version = 'v2'
    AND cutover.cutover_revision =
        projection.population_cutover_revision
    AND membership.plan_id = cutover.selected_plan_id
    AND membership.entity_id = authority.entity_id
    AND NOT projection.population_v2_suppressed;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  population_entity_state_v2_synchronize_permanent_resources
ON population_entity_state_v2;

CREATE TRIGGER population_entity_state_v2_synchronize_permanent_resources
AFTER UPDATE OF state, state_revision, state_actor_player_id,
  killed_or_harvested_at, respawn_at
ON population_entity_state_v2
FOR EACH ROW
EXECUTE FUNCTION synchronize_permanent_resource_projection_v2();

-- Fail closed for retained canonical lives that cannot be reconstructed from
-- an actual harvest timestamp. The diagnostic includes every identity needed
-- to investigate the physical authority, selected plan, and projection fence.
DO $$
DECLARE
  malformed_rows text;
BEGIN
  SELECT jsonb_agg(to_jsonb(malformed) ORDER BY malformed.entity_id)::text
  INTO malformed_rows
  FROM (
    SELECT canonical.entity_id::text,
           authority.node_type AS resource_type,
           canonical.state AS canonical_state,
           canonical.state_actor_player_id AS harvest_actor_player_id,
           canonical.killed_or_harvested_at,
           canonical.respawn_at,
           canonical.state_revision AS canonical_revision,
           projection.population_v2_state_revision AS projection_revision,
           authority.owner_zone_id AS zone_id,
           cutover.selected_plan_id::text AS selected_plan_id,
           projection.population_cutover_revision AS cutover_revision
    FROM population_permanent_resource_authority_v2 AS authority
    JOIN population_entity_state_v2 AS canonical
      ON canonical.entity_id = authority.entity_id
    LEFT JOIN repeatable_resource_nodes AS projection
      ON projection.population_v2_entity_id = authority.entity_id
    LEFT JOIN LATERAL (
      SELECT candidate.selected_plan_id
      FROM population_zone_cutovers_v2 AS candidate
      WHERE candidate.zone_id = authority.owner_zone_id
        AND (
          projection.population_cutover_revision IS NULL
          OR candidate.cutover_revision =
             projection.population_cutover_revision
        )
      ORDER BY candidate.updated_at DESC
      LIMIT 1
    ) AS cutover ON true
    WHERE canonical.state NOT IN ('ready', 'harvested')
       OR (
         canonical.state = 'ready'
         AND (
           canonical.state_actor_player_id IS NOT NULL
           OR canonical.killed_or_harvested_at IS NOT NULL
           OR canonical.respawn_at IS NOT NULL
         )
       )
       OR (
         canonical.state = 'harvested'
         AND canonical.killed_or_harvested_at IS NULL
       )
    ORDER BY canonical.entity_id
    LIMIT 25
  ) AS malformed;

  IF malformed_rows IS NOT NULL THEN
    RAISE EXCEPTION
      'unrecoverable retained permanent-resource canonical lifecycle rows'
      USING ERRCODE = '23514',
            CONSTRAINT =
              'population_entity_state_v2_permanent_resource_retained_lifecycle',
            DETAIL = malformed_rows,
            HINT =
              'Restore a trustworthy harvest timestamp or quarantine the listed entity identities before retrying migration 0713.';
  END IF;
END $$;

-- A retained harvested life with a trustworthy event time keeps that life.
-- Only its derived deadline is corrected; migration time is never used.
UPDATE population_entity_state_v2 AS canonical
SET respawn_at =
      canonical.killed_or_harvested_at + authority.regeneration_interval
FROM population_permanent_resource_authority_v2 AS authority
WHERE canonical.entity_id = authority.entity_id
  AND canonical.state = 'harvested'
  AND canonical.killed_or_harvested_at IS NOT NULL
  AND canonical.respawn_at IS DISTINCT FROM
      canonical.killed_or_harvested_at + authority.regeneration_interval;

-- Idempotently repair only projections whose immutable authority, selected
-- stable plan, physical owner, cutover, and definition all agree.
UPDATE repeatable_resource_nodes AS projection
SET ready_at = CASE
      WHEN canonical.state = 'ready' THEN '-infinity'::timestamptz
      ELSE canonical.respawn_at
    END,
    harvest_revision = canonical.state_revision,
    last_harvested_by = CASE
      WHEN canonical.state = 'ready' THEN NULL
      ELSE canonical.state_actor_player_id
    END,
    population_v2_state_revision = canonical.state_revision
FROM population_entity_state_v2 AS canonical,
     population_permanent_resource_authority_v2 AS authority,
     population_zone_cutovers_v2 AS cutover,
     population_plan_permanent_resources_v2 AS membership
WHERE projection.population_v2_entity_id = canonical.entity_id
  AND authority.entity_id = canonical.entity_id
  AND authority.owner_zone_id = projection.physical_population_zone_v2_id
  AND projection.node_type = authority.node_type
  AND projection.yield_item_id = authority.yield_item_id
  AND projection.yield_quantity = authority.yield_quantity
  AND projection.regeneration_interval = authority.regeneration_interval
  AND cutover.zone_id = authority.owner_zone_id
  AND cutover.status = 'stable'
  AND cutover.serving_version = 'v2'
  AND cutover.cutover_revision = projection.population_cutover_revision
  AND membership.plan_id = cutover.selected_plan_id
  AND membership.entity_id = authority.entity_id
  AND NOT projection.population_v2_suppressed
  AND (
    projection.population_v2_state_revision <> canonical.state_revision
    OR projection.harvest_revision <> canonical.state_revision
    OR projection.ready_at IS DISTINCT FROM CASE
      WHEN canonical.state = 'ready' THEN '-infinity'::timestamptz
      ELSE canonical.respawn_at
    END
    OR projection.last_harvested_by IS DISTINCT FROM CASE
      WHEN canonical.state = 'ready' THEN NULL
      ELSE canonical.state_actor_player_id
    END
  );
