ALTER TABLE population_zone_generations_v2
  ADD COLUMN IF NOT EXISTS density_revision text NOT NULL
    DEFAULT 'legacy-unverified',
  ADD COLUMN IF NOT EXISTS plan_content_hash text NOT NULL
    DEFAULT 'legacy-unverified',
  ADD COLUMN IF NOT EXISTS candidate_layout_version text NOT NULL
    DEFAULT 'legacy-unverified',
  ADD COLUMN IF NOT EXISTS materialization_revision text NOT NULL
    DEFAULT 'legacy-unverified';

COMMENT ON COLUMN population_zone_generations_v2.materialization_revision IS
  'Exact generator materialization contract; legacy-unverified rows reconcile before fast-path reuse.';
