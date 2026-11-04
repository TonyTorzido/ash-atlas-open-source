-- Salon Eyes/Nose/Mouth: separate nose and mouth selections plus one movable point per
-- face feature. Points are face-anchor local units; NULL means "use the area default".
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS nose_appearance_id text NULL,
  ADD COLUMN IF NOT EXISTS mouth_appearance_id text NULL,
  ADD COLUMN IF NOT EXISTS eyes_feature_x double precision NULL,
  ADD COLUMN IF NOT EXISTS eyes_feature_y double precision NULL,
  ADD COLUMN IF NOT EXISTS nose_feature_x double precision NULL,
  ADD COLUMN IF NOT EXISTS nose_feature_y double precision NULL,
  ADD COLUMN IF NOT EXISTS mouth_feature_x double precision NULL,
  ADD COLUMN IF NOT EXISTS mouth_feature_y double precision NULL;

ALTER TABLE players
  DROP CONSTRAINT IF EXISTS players_face_feature_points_check;

-- BETWEEN rejects NaN and +/-Infinity, so stored points are always finite and bounded.
ALTER TABLE players
  ADD CONSTRAINT players_face_feature_points_check CHECK (
    (eyes_feature_x IS NULL) = (eyes_feature_y IS NULL) AND
    (nose_feature_x IS NULL) = (nose_feature_y IS NULL) AND
    (mouth_feature_x IS NULL) = (mouth_feature_y IS NULL) AND
    (eyes_feature_x IS NULL OR (
      eyes_feature_x BETWEEN -512 AND 512 AND eyes_feature_y BETWEEN -512 AND 512
    )) AND
    (nose_feature_x IS NULL OR (
      nose_feature_x BETWEEN -512 AND 512 AND nose_feature_y BETWEEN -512 AND 512
    )) AND
    (mouth_feature_x IS NULL OR (
      mouth_feature_x BETWEEN -512 AND 512 AND mouth_feature_y BETWEEN -512 AND 512
    ))
  );
