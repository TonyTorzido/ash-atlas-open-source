-- Once global v2 authority is enabled, raced or forgotten v1 writers must
-- fail closed. Historical v1 rows remain readable and mutable for durable
-- death/harvest history and guarded cutover compensation.

CREATE OR REPLACE FUNCTION reject_global_v1_population_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.population_v2_entity_id IS NULL
     AND EXISTS (
       SELECT 1
       FROM population_v2_rollout_control
       WHERE singleton AND mode = 'enabled'
     ) THEN
    RAISE EXCEPTION 'legacy population creation is disabled by global population v2 authority'
      USING ERRCODE = '55000',
            CONSTRAINT = 'population_v2_global_legacy_creation_fence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collectible_nodes_global_v1_population_fence
BEFORE INSERT ON collectible_nodes
FOR EACH ROW EXECUTE FUNCTION reject_global_v1_population_insert_v2();

CREATE TRIGGER generated_world_mobs_global_v1_population_fence
BEFORE INSERT ON generated_world_mobs
FOR EACH ROW EXECUTE FUNCTION reject_global_v1_population_insert_v2();

CREATE TRIGGER repeatable_resource_nodes_global_v1_population_fence
BEFORE INSERT ON repeatable_resource_nodes
FOR EACH ROW EXECUTE FUNCTION reject_global_v1_population_insert_v2();
