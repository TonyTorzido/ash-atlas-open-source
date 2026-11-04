ALTER TABLE xoral_events
  ADD COLUMN IF NOT EXISTS appearance_variant text NULL;

ALTER TABLE xoral_events
  DROP CONSTRAINT IF EXISTS xoral_events_appearance_variant_check;

ALTER TABLE xoral_events
  ADD CONSTRAINT xoral_events_appearance_variant_check
  CHECK (appearance_variant IS NULL OR appearance_variant IN ('normal', 'ashen'));
