-- Wrap spatial lock cells at the antimeridian so geometrically adjacent
-- placements acquire an overlapping deterministic lock set.
CREATE OR REPLACE FUNCTION lock_flag_placement_cells(candidate_geom geometry)
RETURNS void AS $$
DECLARE
  projected geometry;
  cell_size_m constant double precision := 10000.05;
  web_mercator_half_world_m constant double precision := 20037508.342789244;
  horizontal_cell_count constant bigint :=
    ceil((web_mercator_half_world_m * 2) / cell_size_m)::bigint;
  center_x bigint;
  center_y bigint;
  lock_cell record;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('flag-control-geometry', 0)
  );

  projected := ST_Transform(candidate_geom, 3857);
  center_x := floor(
    (ST_X(projected) + web_mercator_half_world_m) / cell_size_m
  )::bigint;
  center_y := floor(ST_Y(projected) / cell_size_m)::bigint;

  FOR lock_cell IN
    SELECT
      ((center_x + x_offset) % horizontal_cell_count + horizontal_cell_count)
        % horizontal_cell_count AS x,
      center_y + y_offset AS y
    FROM generate_series(-1, 1) AS x_offset
    CROSS JOIN generate_series(-1, 1) AS y_offset
    ORDER BY x, y
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        format(
          'ash-atlas-flag-placement-cell-v1:%s:%s',
          lock_cell.x,
          lock_cell.y
        ),
        0
      )
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION lock_flag_placement_cells(geometry) IS
  'Shared topology gate plus deterministic antimeridian-safe local advisory locks for concurrent flag placement.';
