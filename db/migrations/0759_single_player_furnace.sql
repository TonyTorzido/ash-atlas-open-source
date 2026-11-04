ALTER TABLE player_furnaces
  ADD COLUMN removed_at timestamptz NULL,
  ADD COLUMN removal_reason text NULL;

WITH ranked AS (
  SELECT
    furnace_id,
    row_number() OVER (
      PARTITION BY owner_player_id
      ORDER BY built_at, created_at, furnace_id
    ) AS owner_ordinal
  FROM player_furnaces
)
UPDATE player_furnaces furnace
SET removed_at = clock_timestamp(),
    removal_reason = 'owner_limit_reconciliation',
    updated_at = clock_timestamp()
FROM ranked
WHERE ranked.furnace_id = furnace.furnace_id
  AND ranked.owner_ordinal > 1;

UPDATE furnace_build_jobs build
SET status = 'cancelled',
    furnace_id = NULL,
    cancel_reason = 'owner_limit_reconciliation',
    updated_at = clock_timestamp()
FROM player_furnaces furnace
WHERE build.furnace_id = furnace.furnace_id
  AND furnace.removed_at IS NOT NULL;

CREATE UNIQUE INDEX player_furnaces_active_owner_unique
  ON player_furnaces (owner_player_id)
  WHERE removed_at IS NULL;
