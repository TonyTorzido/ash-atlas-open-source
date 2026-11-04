-- Fix forward: permanent v1 repeatable resource nodes must acquire the same
-- physical-zone cutover classification as other legacy population projections.

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
  ELSIF TG_TABLE_NAME = 'repeatable_resource_nodes' THEN
    generated_v1 := true;
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

DROP TRIGGER IF EXISTS repeatable_resource_nodes_classify_v1_population_v2
  ON repeatable_resource_nodes;
CREATE TRIGGER repeatable_resource_nodes_classify_v1_population_v2
BEFORE INSERT OR UPDATE OF geom, population_cutover_suppressed
ON repeatable_resource_nodes
FOR EACH ROW EXECUTE FUNCTION classify_v1_population_projection_cutover_v2();
