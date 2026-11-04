-- Developer-only warfare fixtures use the canonical Flags and military unit
-- rows while carrying a narrow marker for target eligibility.  The marker is
-- never set by ordinary player placement and is scoped to its creator below.
ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS developer_test_target boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN flags.developer_test_target IS
  'Explicit developer test target; only the spawning developer may use it as a military target.';

CREATE OR REPLACE FUNCTION enforce_flag_center_outside_existing_claim()
RETURNS trigger AS $$
DECLARE
  covering_flag_id uuid;
BEGIN
  -- Developer test targets are intentionally local fixtures. They still use
  -- canonical Flag persistence and geometry, but their placement is allowed
  -- to overlap an existing claim so a developer can stage a test at hand.
  IF NEW.developer_test_target THEN
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS flags_center_outside_existing_claim ON flags;
CREATE TRIGGER flags_center_outside_existing_claim
BEFORE INSERT OR UPDATE OF lat, lon, geom, developer_test_target ON flags
FOR EACH ROW
EXECUTE FUNCTION enforce_flag_center_outside_existing_claim();

CREATE TABLE IF NOT EXISTS developer_spawned_test_flags (
  flag_id uuid PRIMARY KEY REFERENCES flags(id) ON DELETE CASCADE,
  creator_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  target_kind text NOT NULL CHECK (target_kind IN ('soft_flag','bastion_flag','tower')),
  spawn_lat double precision NOT NULL CHECK (spawn_lat BETWEEN -90 AND 90),
  spawn_lon double precision NOT NULL CHECK (spawn_lon BETWEEN -180 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_player_id, request_id)
);

CREATE INDEX IF NOT EXISTS developer_spawned_test_flags_creator_idx
  ON developer_spawned_test_flags(creator_player_id, created_at, flag_id);

ALTER TABLE military_unit_operations
  DROP CONSTRAINT IF EXISTS military_unit_operations_action_check;

ALTER TABLE military_unit_operations
  ADD CONSTRAINT military_unit_operations_action_check CHECK (action IN (
    'combine','split','load_bombers','build_war_camp','call_troops',
    'relocate_war_camp','remove_war_camp','follow','deploy','return','stop',
    'repair_ballista','attack','developer_spawn'
  ));
