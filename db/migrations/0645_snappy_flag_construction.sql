-- Durable request identity keeps flag construction replay-safe across process restarts.
CREATE TABLE IF NOT EXISTS flag_build_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  flag_id uuid NOT NULL UNIQUE REFERENCES flags(id) ON DELETE CASCADE,
  materials_refunded boolean NOT NULL DEFAULT false,
  refund_chance double precision NOT NULL DEFAULT 0
    CHECK (refund_chance >= 0 AND refund_chance <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS flag_build_operations_player_created_idx
  ON flag_build_operations (player_id, created_at DESC);

-- Personal flag writers share the topology gate, so they can run concurrently.
-- Rare City/Kingdom geometry mutations keep taking the existing exclusive gate.
-- Potentially conflicting personal writers additionally serialize on a sorted
-- 3x3 neighborhood of deterministic Web Mercator cells.
CREATE OR REPLACE FUNCTION lock_flag_placement_cells(candidate_geom geometry)
RETURNS void AS $$
DECLARE
  projected geometry;
  cell_size_m constant double precision := 10000.05;
  center_x bigint;
  center_y bigint;
  offset_x integer;
  offset_y integer;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('flag-control-geometry', 0)
  );

  projected := ST_Transform(candidate_geom, 3857);
  center_x := floor(ST_X(projected) / cell_size_m)::bigint;
  center_y := floor(ST_Y(projected) / cell_size_m)::bigint;

  FOR offset_x IN -1..1 LOOP
    FOR offset_y IN -1..1 LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended(
          format(
            'ash-atlas-flag-placement-cell-v1:%s:%s',
            center_x + offset_x,
            center_y + offset_y
          ),
          0
        )
      );
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_flag_center_outside_existing_claim()
RETURNS trigger AS $$
DECLARE
  covering_flag_id uuid;
BEGIN
  PERFORM lock_flag_placement_cells(NEW.geom);

  SELECT existing.id
  INTO covering_flag_id
  FROM flags existing
  WHERE existing.id <> NEW.id
    AND ST_DWithin(
      existing.geom::geography,
      NEW.geom::geography,
      10000.05
    )
    AND ST_DWithin(
      existing.geom::geography,
      NEW.geom::geography,
      existing.claim_radius_m + 0.05
    )
  ORDER BY existing.id
  LIMIT 1;

  IF covering_flag_id IS NOT NULL THEN
    RAISE EXCEPTION
      'flag center is inside existing claim %',
      covering_flag_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'flags_center_outside_existing_claim';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION lock_flag_placement_cells(geometry) IS
  'Shared topology gate plus deterministic local advisory locks for concurrent flag placement.';
