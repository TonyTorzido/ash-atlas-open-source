CREATE TABLE population_river_water_suppressions_v1 (
  entity_id uuid PRIMARY KEY
    REFERENCES population_spawn_slots_v2(entity_id) ON DELETE RESTRICT,
  entity_kind text NOT NULL
    CHECK (entity_kind IN ('tree','deer','wolf','ogre','stone','sap_crawler')),
  generation_id uuid NULL,
  river_release_id text NOT NULL CHECK (river_release_id = 'river-surface-v1'),
  river_manifest_sha256 text NOT NULL
    CHECK (river_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  river_row_id bigint NOT NULL CHECK (river_row_id >= 0),
  river_column_id bigint NOT NULL CHECK (river_column_id >= 0),
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION reject_river_water_population_suppression_change_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'river water population suppression receipts are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'population_river_water_suppressions_v1_immutable';
END;
$$;

CREATE TRIGGER population_river_water_suppressions_v1_reject_change
BEFORE UPDATE OR DELETE ON population_river_water_suppressions_v1
FOR EACH ROW EXECUTE FUNCTION reject_river_water_population_suppression_change_v1();

COMMENT ON TABLE population_river_water_suppressions_v1 IS
  'Immutable exact river-surface-v1 conflicts retired from generated land population; player-owned objects are never recorded here.';
