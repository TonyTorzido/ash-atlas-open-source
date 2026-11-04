-- Expand the authoritative fishing stamina pool while preserving the
-- percentage represented by encounters already in progress.
ALTER TABLE fishing_encounters
  DROP CONSTRAINT IF EXISTS fishing_encounters_stamina_check;

ALTER TABLE fishing_encounters
  ADD CONSTRAINT fishing_encounters_stamina_check
  CHECK (stamina BETWEEN 0 AND 150);

ALTER TABLE fishing_encounters
  ALTER COLUMN stamina SET DEFAULT 150;

UPDATE fishing_encounters
SET stamina = LEAST(150, stamina * 1.5)
WHERE phase IN ('cast', 'bite', 'hooked', 'fighting')
  AND stamina BETWEEN 0 AND 100;
