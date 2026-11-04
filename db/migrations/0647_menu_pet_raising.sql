CREATE TABLE player_pets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  species text NOT NULL CHECK (species IN ('emberhorn_whelp', 'gloam_hare', 'ashfang_pup')),
  custom_name text NOT NULL CHECK (
    char_length(custom_name) BETWEEN 1 AND 24
    AND custom_name = btrim(custom_name)
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  care_days smallint NOT NULL DEFAULT 0 CHECK (care_days BETWEEN 0 AND 30),
  personality_trait text CHECK (
    personality_trait IS NULL
    OR personality_trait IN ('Affectionate', 'Energetic', 'Regal', 'Curious', 'Calm')
  ),
  interaction_count_pet integer NOT NULL DEFAULT 0 CHECK (interaction_count_pet >= 0),
  interaction_count_play integer NOT NULL DEFAULT 0 CHECK (interaction_count_play >= 0),
  interaction_count_groom integer NOT NULL DEFAULT 0 CHECK (interaction_count_groom >= 0),
  interaction_count_tell_story integer NOT NULL DEFAULT 0 CHECK (interaction_count_tell_story >= 0),
  interaction_count_let_rest integer NOT NULL DEFAULT 0 CHECK (interaction_count_let_rest >= 0),
  adopted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_pets_completion_state CHECK (
    (status = 'active' AND care_days < 30 AND completed_at IS NULL AND personality_trait IS NULL)
    OR
    (status = 'completed' AND care_days = 30 AND completed_at IS NOT NULL AND personality_trait IS NOT NULL)
  ),
  UNIQUE (player_id, species)
);

CREATE UNIQUE INDEX player_pets_one_active_per_player
  ON player_pets (player_id)
  WHERE status = 'active';

CREATE INDEX player_pets_player_collection
  ON player_pets (player_id, completed_at DESC NULLS LAST, adopted_at DESC);

DROP TRIGGER IF EXISTS player_pets_set_updated_at ON player_pets;
CREATE TRIGGER player_pets_set_updated_at
BEFORE UPDATE ON player_pets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pet_daily_care (
  pet_id uuid NOT NULL REFERENCES player_pets(id) ON DELETE CASCADE,
  care_date date NOT NULL,
  checked_in_at timestamptz,
  fed_at timestamptz,
  interaction_type text CHECK (
    interaction_type IS NULL
    OR interaction_type IN ('pet', 'play', 'groom', 'tell_story', 'let_rest')
  ),
  interacted_at timestamptz,
  progress_awarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pet_id, care_date),
  CONSTRAINT pet_daily_care_interaction_complete CHECK (
    (interaction_type IS NULL AND interacted_at IS NULL)
    OR
    (interaction_type IS NOT NULL AND interacted_at IS NOT NULL)
  ),
  CONSTRAINT pet_daily_care_progress_complete CHECK (
    progress_awarded_at IS NULL
    OR (checked_in_at IS NOT NULL AND fed_at IS NOT NULL AND interacted_at IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS pet_daily_care_set_updated_at ON pet_daily_care;
CREATE TRIGGER pet_daily_care_set_updated_at
BEFORE UPDATE ON pet_daily_care
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pet_milestones (
  pet_id uuid NOT NULL REFERENCES player_pets(id) ON DELETE CASCADE,
  milestone_key text NOT NULL CHECK (
    milestone_key IN (
      'learns_name', 'first_growth', 'strange_object', 'new_idle',
      'chamber_develops', 'nearly_grown', 'adult_ceremony'
    )
  ),
  care_day smallint NOT NULL CHECK (care_day IN (3, 7, 10, 14, 21, 25, 30)),
  journal_text text NOT NULL CHECK (char_length(journal_text) BETWEEN 1 AND 500),
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pet_id, milestone_key)
);

CREATE INDEX pet_milestones_pet_day
  ON pet_milestones (pet_id, care_day);
