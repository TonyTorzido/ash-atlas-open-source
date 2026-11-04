-- Furnace jobs may carry their own per-unit duration (a Artisan Glove makes each smelting
-- operation take 1 second). NULL keeps the recipe duration. Forward-only and idempotent.
ALTER TABLE furnace_smelt_jobs
  ADD COLUMN IF NOT EXISTS duration_ms integer NULL CHECK (duration_ms IS NULL OR duration_ms > 0);
