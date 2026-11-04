-- A Ballista volley is one replayable operation that may affect several
-- eligible personal Flags. Keep the original single target columns for
-- compatibility and retain the complete per-target result for reconciliation
-- and exact replay.
ALTER TABLE military_siege_operations
  ADD COLUMN IF NOT EXISTS target_results jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN military_siege_operations.target_results IS
  'Immutable JSON array of {flagId,damage,health,damageCycleId} rows applied by an area Ballista volley; empty for legacy single-target rows.';
