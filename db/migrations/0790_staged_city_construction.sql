-- New cities reserve their municipality and territory immediately, but remain
-- non-jumpable until four different players complete the civic construction.
-- Retained cities predate staged construction and remain fully complete.

ALTER TABLE cities
  ADD COLUMN construction_phase text NOT NULL DEFAULT 'complete',
  ADD COLUMN construction_completed_at timestamptz NULL DEFAULT clock_timestamp();

UPDATE cities
SET construction_phase = 'complete',
    construction_completed_at = COALESCE(construction_completed_at, created_at);

ALTER TABLE cities
  ADD CONSTRAINT cities_construction_phase_valid CHECK (
    construction_phase IN ('blueprint', 'foundation', 'framing', 'complete')
  ),
  ADD CONSTRAINT cities_construction_completion_valid CHECK (
    (construction_phase = 'complete' AND construction_completed_at IS NOT NULL)
    OR (construction_phase <> 'complete' AND construction_completed_at IS NULL)
  );

CREATE TABLE city_construction_contributions (
  contribution_id bigserial PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  stage text NOT NULL CHECK (stage IN ('blueprint', 'foundation', 'framing', 'finishing')),
  action text NOT NULL CHECK (
    action IN ('found_city', 'build_foundation', 'build_frames', 'finish')
  ),
  material_item_id text NULL,
  material_quantity bigint NULL,
  gold_amount bigint NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (city_id, stage),
  UNIQUE (city_id, actor_player_id),
  UNIQUE (actor_player_id, request_id),
  CHECK (
    (stage = 'blueprint' AND action = 'found_city'
      AND material_item_id IS NULL AND material_quantity IS NULL AND gold_amount IS NULL)
    OR (stage = 'foundation' AND action = 'build_foundation'
      AND material_item_id = 'stone' AND material_quantity = 120 AND gold_amount IS NULL)
    OR (stage = 'framing' AND action = 'build_frames'
      AND material_item_id = 'wood' AND material_quantity = 450 AND gold_amount IS NULL)
    OR (stage = 'finishing' AND action = 'finish'
      AND material_item_id IS NULL AND material_quantity IS NULL AND gold_amount = 4500)
  )
);

CREATE INDEX city_construction_contributions_city_created_idx
  ON city_construction_contributions (city_id, created_at, contribution_id);

CREATE TRIGGER city_construction_contributions_immutable
BEFORE UPDATE OR DELETE ON city_construction_contributions
FOR EACH ROW EXECUTE FUNCTION reject_city_ledger_mutation();

COMMENT ON TABLE city_construction_contributions IS
  'Append-only civic construction ledger; unique city actors enforce four distinct contributors.';
