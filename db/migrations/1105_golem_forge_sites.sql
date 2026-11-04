-- Golem Forge batch 2b (docs/design/GOLEM_FORGE_PLAN.md section 2): world sites and collapse.
--
-- golem_forge_sites: one row per Forge region (an equal-area domain, '<band>:<column>' in base 36),
-- written only once something happens there. A region with no row opens the first land slot from 0.
-- cycle is where the land-slot search starts (the open slot, once a Forgemaster died there);
-- collapse_at is 24 h after its Forgemaster died. The site shows as collapsed from collapse_at for an
-- hour, then the region moves to the next land slot (cycle = slot + 1, collapse_at cleared).
CREATE TABLE IF NOT EXISTS golem_forge_sites (
  region_key text PRIMARY KEY,
  cycle integer NOT NULL DEFAULT 0,
  collapse_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT golem_forge_sites_region_valid CHECK (region_key ~ '^[0-9a-z]+:[0-9a-z]+$'),
  CONSTRAINT golem_forge_sites_cycle_valid CHECK (cycle >= 0)
);

CREATE INDEX IF NOT EXISTS golem_forge_sites_collapse_idx
  ON golem_forge_sites (collapse_at) WHERE collapse_at IS NOT NULL;

-- A collapse refunds every paid admission nobody used; a refunded admission can never be entered.
ALTER TABLE dungeon_run_admissions ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE dungeon_run_admissions DROP CONSTRAINT IF EXISTS dungeon_run_admissions_used_once;
ALTER TABLE dungeon_run_admissions ADD CONSTRAINT dungeon_run_admissions_used_once
  CHECK (entered_at IS NULL OR refunded_at IS NULL);
