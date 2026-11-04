ALTER TABLE players
  ADD COLUMN IF NOT EXISTS body_variant_id text NOT NULL DEFAULT 'default';

ALTER TABLE players
  DROP CONSTRAINT IF EXISTS players_body_variant_id_check;

ALTER TABLE players
  ADD CONSTRAINT players_body_variant_id_check
  CHECK (body_variant_id IN ('default', 'female'));
