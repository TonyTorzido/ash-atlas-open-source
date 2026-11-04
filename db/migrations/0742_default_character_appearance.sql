ALTER TABLE players
  ALTER COLUMN hair_appearance_id SET DEFAULT 'hair-1',
  ALTER COLUMN eyes_appearance_id SET DEFAULT 'eyes-2',
  ALTER COLUMN nose_mouth_appearance_id SET DEFAULT 'mouth-1',
  ALTER COLUMN mask_appearance_id SET DEFAULT NULL;

UPDATE players
SET hair_appearance_id = 'hair-1',
    eyes_appearance_id = 'eyes-2',
    nose_mouth_appearance_id = 'mouth-1',
    mask_appearance_id = NULL,
    base_appearance_revision = base_appearance_revision + 1;
