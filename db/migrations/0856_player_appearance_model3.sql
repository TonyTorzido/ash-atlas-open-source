ALTER TABLE players
  ADD COLUMN IF NOT EXISTS beard_appearance_id text NULL,
  ADD COLUMN IF NOT EXISTS skin_tone_id text NOT NULL DEFAULT 'light';

ALTER TABLE players
  ALTER COLUMN hair_appearance_id SET DEFAULT 'spikey-hair',
  ALTER COLUMN eyes_appearance_id SET DEFAULT 'brown-eyes',
  ALTER COLUMN nose_mouth_appearance_id SET DEFAULT NULL,
  ALTER COLUMN beard_appearance_id SET DEFAULT NULL,
  ALTER COLUMN mask_appearance_id SET DEFAULT NULL,
  ALTER COLUMN legs_overlay_appearance_id SET DEFAULT 'black-pants',
  ALTER COLUMN skin_tone_id SET DEFAULT 'light';

UPDATE players
SET hair_appearance_id = 'spikey-hair',
    eyes_appearance_id = 'brown-eyes',
    nose_mouth_appearance_id = NULL,
    beard_appearance_id = NULL,
    mask_appearance_id = NULL,
    legs_overlay_appearance_id = 'black-pants',
    skin_tone_id = 'light',
    base_appearance_revision = base_appearance_revision + 1
WHERE hair_appearance_id IS DISTINCT FROM 'spikey-hair'
   OR eyes_appearance_id IS DISTINCT FROM 'brown-eyes'
   OR nose_mouth_appearance_id IS NOT NULL
   OR beard_appearance_id IS NOT NULL
   OR mask_appearance_id IS NOT NULL
   OR legs_overlay_appearance_id IS DISTINCT FROM 'black-pants'
   OR skin_tone_id IS DISTINCT FROM 'light';
