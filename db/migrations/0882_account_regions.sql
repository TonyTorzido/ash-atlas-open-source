BEGIN;

-- Per-account land-action regions (0.5 degree cells). interaction_days counts
-- distinct UTC days with a land action in the cell; WP6 derives familiarity.
CREATE TABLE IF NOT EXISTS account_regions (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  region_cell text NOT NULL CHECK (region_cell ~ '^-?[0-9]+:-?[0-9]+$'),
  interaction_days integer NOT NULL DEFAULT 1 CHECK (interaction_days >= 1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_counted_day date NOT NULL,
  PRIMARY KEY (account_id, region_cell)
);

CREATE INDEX IF NOT EXISTS account_regions_account_days_idx
  ON account_regions (account_id, interaction_days DESC);

COMMIT;
