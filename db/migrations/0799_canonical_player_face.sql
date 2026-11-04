ALTER TABLE players
  ALTER COLUMN eyes_appearance_id SET DEFAULT 'brown-eyes-1',
  ALTER COLUMN nose_mouth_appearance_id SET DEFAULT NULL;

UPDATE players
SET eyes_appearance_id = 'brown-eyes-1',
    nose_mouth_appearance_id = NULL,
    base_appearance_revision = base_appearance_revision + 1
WHERE eyes_appearance_id IS DISTINCT FROM 'brown-eyes-1'
   OR nose_mouth_appearance_id IS NOT NULL;
