-- Permanent mines belong to their physical zone across plan revisions. Repair
-- only projections demonstrably fenced by an older cutover; projections at
-- the current revision without selected-plan membership are staged for a
-- future plan and must remain hidden until that plan is selected.

DO $$
DECLARE malformed_rows text;
BEGIN
  SELECT jsonb_agg(to_jsonb(malformed) ORDER BY malformed.entity_id)::text
  INTO malformed_rows
  FROM (
    SELECT authority.entity_id::text,
           authority.owner_zone_id AS zone_id,
           cutover.selected_plan_id::text,
           cutover.cutover_revision::text AS selected_cutover_revision,
           projection.population_cutover_revision::text
             AS projection_cutover_revision
    FROM population_permanent_resource_authority_v2 AS authority
    JOIN population_zone_cutovers_v2 AS cutover
      ON cutover.zone_id=authority.owner_zone_id
     AND cutover.serving_version='v2'
     AND cutover.status='stable'
    LEFT JOIN repeatable_resource_nodes AS projection
      ON projection.population_v2_entity_id=authority.entity_id
    LEFT JOIN population_entity_state_v2 AS canonical
      ON canonical.entity_id=authority.entity_id
    WHERE projection.id IS NULL
       OR canonical.entity_id IS NULL
       OR projection.physical_population_zone_v2_id
            IS DISTINCT FROM authority.owner_zone_id
       OR projection.node_type IS DISTINCT FROM authority.node_type
       OR projection.yield_item_id IS DISTINCT FROM authority.yield_item_id
       OR projection.yield_quantity IS DISTINCT FROM authority.yield_quantity
       OR projection.regeneration_interval
            IS DISTINCT FROM authority.regeneration_interval
       OR projection.population_cutover_revision IS NULL
       OR projection.population_cutover_revision > cutover.cutover_revision
    ORDER BY authority.entity_id
    LIMIT 25
  ) AS malformed;

  IF malformed_rows IS NOT NULL THEN
    RAISE EXCEPTION
      'unsafe permanent-mine cutover continuity repair candidates'
      USING ERRCODE='23514',
            CONSTRAINT='population_permanent_mine_cutover_continuity',
            DETAIL=malformed_rows,
            HINT='Repair or quarantine the listed authority, projection, or canonical rows before retrying migration 0764.';
  END IF;
END $$;

INSERT INTO population_plan_permanent_stones_v2 (plan_id, entity_id)
SELECT cutover.selected_plan_id, authority.entity_id
FROM population_permanent_resource_authority_v2 AS authority
JOIN population_zone_cutovers_v2 AS cutover
  ON cutover.zone_id=authority.owner_zone_id
 AND cutover.serving_version='v2'
 AND cutover.status='stable'
JOIN repeatable_resource_nodes AS projection
  ON projection.population_v2_entity_id=authority.entity_id
 AND projection.physical_population_zone_v2_id=authority.owner_zone_id
 AND projection.node_type=authority.node_type
 AND projection.yield_item_id=authority.yield_item_id
 AND projection.yield_quantity=authority.yield_quantity
 AND projection.regeneration_interval=authority.regeneration_interval
JOIN population_entity_state_v2 AS canonical
  ON canonical.entity_id=authority.entity_id
WHERE projection.population_cutover_revision < cutover.cutover_revision
ON CONFLICT (plan_id, entity_id) DO NOTHING;

UPDATE repeatable_resource_nodes AS projection
SET population_cutover_revision=cutover.cutover_revision
FROM population_permanent_resource_authority_v2 AS authority,
     population_zone_cutovers_v2 AS cutover,
     population_entity_state_v2 AS canonical,
     population_plan_permanent_resources_v2 AS membership
WHERE projection.population_v2_entity_id=authority.entity_id
  AND projection.physical_population_zone_v2_id=authority.owner_zone_id
  AND projection.node_type=authority.node_type
  AND projection.yield_item_id=authority.yield_item_id
  AND projection.yield_quantity=authority.yield_quantity
  AND projection.regeneration_interval=authority.regeneration_interval
  AND canonical.entity_id=authority.entity_id
  AND cutover.zone_id=authority.owner_zone_id
  AND cutover.serving_version='v2'
  AND cutover.status='stable'
  AND membership.plan_id=cutover.selected_plan_id
  AND membership.entity_id=authority.entity_id
  AND projection.population_cutover_revision < cutover.cutover_revision;

CREATE OR REPLACE FUNCTION enforce_permanent_mine_cutover_continuity_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE malformed_rows text;
BEGIN
  IF TG_OP='UPDATE'
    AND NEW.selected_plan_id IS NOT DISTINCT FROM OLD.selected_plan_id
    AND NEW.cutover_revision=OLD.cutover_revision
    AND NEW.serving_version=OLD.serving_version
    AND NEW.status=OLD.status
  THEN
    RETURN NULL;
  END IF;

  IF NEW.serving_version<>'v2' OR NEW.status<>'stable' THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_agg(to_jsonb(malformed) ORDER BY malformed.entity_id)::text
  INTO malformed_rows
  FROM (
    SELECT authority.entity_id::text,
           NEW.zone_id AS zone_id,
           NEW.selected_plan_id::text AS selected_plan_id,
           NEW.cutover_revision::text AS cutover_revision
    FROM population_permanent_resource_authority_v2 AS authority
    LEFT JOIN population_plan_permanent_resources_v2 AS membership
      ON membership.plan_id=NEW.selected_plan_id
     AND membership.entity_id=authority.entity_id
    LEFT JOIN repeatable_resource_nodes AS projection
      ON projection.population_v2_entity_id=authority.entity_id
    LEFT JOIN population_entity_state_v2 AS canonical
      ON canonical.entity_id=authority.entity_id
    WHERE authority.owner_zone_id=NEW.zone_id
      AND (
        membership.entity_id IS NULL
        OR projection.id IS NULL
        OR canonical.entity_id IS NULL
        OR projection.physical_population_zone_v2_id
             IS DISTINCT FROM authority.owner_zone_id
        OR projection.node_type IS DISTINCT FROM authority.node_type
        OR projection.yield_item_id IS DISTINCT FROM authority.yield_item_id
        OR projection.yield_quantity IS DISTINCT FROM authority.yield_quantity
        OR projection.regeneration_interval
             IS DISTINCT FROM authority.regeneration_interval
        OR projection.population_cutover_revision
             IS DISTINCT FROM NEW.cutover_revision
      )
    ORDER BY authority.entity_id
    LIMIT 25
  ) AS malformed;

  IF malformed_rows IS NOT NULL THEN
    RAISE EXCEPTION 'permanent-mine cutover continuity is incomplete'
      USING ERRCODE='23514',
            CONSTRAINT='population_permanent_mine_cutover_continuity',
            DETAIL=malformed_rows;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS population_zone_cutovers_v2_permanent_mine_continuity
ON population_zone_cutovers_v2;

CREATE CONSTRAINT TRIGGER
  population_zone_cutovers_v2_permanent_mine_continuity
AFTER INSERT OR UPDATE ON population_zone_cutovers_v2
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_permanent_mine_cutover_continuity_v2();

COMMENT ON FUNCTION enforce_permanent_mine_cutover_continuity_v2() IS
  'Defers stable V2 cutover validation until every zone-owned permanent mine is adopted and fenced to the selected revision.';
