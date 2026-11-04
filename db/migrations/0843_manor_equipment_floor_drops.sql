-- Manor floor drops reuse the established equipment custody ledger while
-- carrying an explicit local-room projection. No house/spill placement is
-- implied by this bounded hook; future house mechanics can add a new kind.
ALTER TABLE world_equipment_drops
  ADD COLUMN IF NOT EXISTS manor_id uuid NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS space_id text NULL,
  ADD COLUMN IF NOT EXISTS local_x double precision NULL,
  ADD COLUMN IF NOT EXISTS local_y double precision NULL;

ALTER TABLE world_equipment_drops
  DROP CONSTRAINT IF EXISTS world_equipment_drops_manor_projection_check;
ALTER TABLE world_equipment_drops
  ADD CONSTRAINT world_equipment_drops_manor_projection_check CHECK (
    (manor_id IS NULL AND space_id IS NULL AND local_x IS NULL AND local_y IS NULL)
    OR (
      manor_id IS NOT NULL
      AND space_id IN ('manor_foyer', 'manor_main_room')
      AND local_x IS NOT NULL AND local_y IS NOT NULL
      AND local_x >= 0 AND local_y >= 0
    )
  );

CREATE INDEX IF NOT EXISTS world_equipment_drops_active_manor_idx
  ON world_equipment_drops (manor_id, space_id, created_at, id)
  WHERE status = 'active' AND manor_id IS NOT NULL;
