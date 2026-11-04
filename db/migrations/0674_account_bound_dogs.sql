CREATE TABLE account_dogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  personality text NOT NULL CHECK (personality IN (
    'Playful', 'Loyal', 'Curious', 'Gentle', 'Brave', 'Mischievous',
    'Affectionate', 'Shy', 'Energetic', 'Sleepy', 'Protective', 'Goofy'
  )),
  name text NOT NULL CHECK (name IN (
    'Milo', 'Teddy', 'Archie', 'Finn', 'Ollie', 'Leo', 'Max', 'Cooper', 'Winston', 'Toby',
    'Luna', 'Daisy', 'Bella', 'Rosie', 'Poppy', 'Millie', 'Ruby', 'Lily', 'Nala', 'Honey',
    'Mochi', 'Biscuit', 'Bean', 'Pepper', 'Scout', 'Sunny', 'Bailey', 'Lucky', 'Maple', 'Coco'
  )),
  gender text NOT NULL CHECK (gender IN ('male', 'female')),
  breed text NOT NULL CHECK (breed IN (
    'Labrador Retriever', 'Golden Retriever', 'German Shepherd',
    'Siberian Husky', 'French Bulldog'
  )),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  country_name text NOT NULL CHECK (
    country_name = btrim(country_name) AND char_length(country_name) BETWEEN 1 AND 120
  ),
  adopted_at timestamptz NOT NULL,
  care_health smallint NOT NULL DEFAULT 100 CHECK (care_health BETWEEN 0 AND 100),
  care_reconciled_through date NOT NULL,
  explore_available_at timestamptz NOT NULL,
  explore_reservation_id uuid,
  explore_reserved_at timestamptz,
  death_at timestamptz,
  death_cause text CHECK (death_cause IN ('Old Age', 'Neglect')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_dogs_name_gender CHECK (
    (name IN ('Milo', 'Teddy', 'Archie', 'Finn', 'Ollie', 'Leo', 'Max', 'Cooper', 'Winston', 'Toby')
      AND gender = 'male')
    OR
    (name IN ('Luna', 'Daisy', 'Bella', 'Rosie', 'Poppy', 'Millie', 'Ruby', 'Lily', 'Nala', 'Honey')
      AND gender = 'female')
    OR
    name IN ('Mochi', 'Biscuit', 'Bean', 'Pepper', 'Scout', 'Sunny', 'Bailey', 'Lucky', 'Maple', 'Coco')
  ),
  CONSTRAINT account_dogs_death_state CHECK (
    (death_at IS NULL AND death_cause IS NULL AND care_health > 0)
    OR
    (death_at IS NOT NULL AND death_cause IS NOT NULL)
  ),
  CONSTRAINT account_dogs_reservation_state CHECK (
    (explore_reservation_id IS NULL AND explore_reserved_at IS NULL)
    OR
    (explore_reservation_id IS NOT NULL AND explore_reserved_at IS NOT NULL AND death_at IS NULL)
  ),
  CONSTRAINT account_dogs_lifecycle_order CHECK (
    death_at IS NULL OR death_at >= adopted_at
  )
);

CREATE UNIQUE INDEX account_dogs_one_living_per_account
  ON account_dogs (account_id)
  WHERE death_at IS NULL;

CREATE INDEX account_dogs_memorial_history
  ON account_dogs (account_id, death_at DESC NULLS FIRST, adopted_at DESC, id);

DROP TRIGGER IF EXISTS account_dogs_set_updated_at ON account_dogs;
CREATE TRIGGER account_dogs_set_updated_at
BEFORE UPDATE ON account_dogs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dog_daily_care (
  dog_id uuid NOT NULL REFERENCES account_dogs(id) ON DELETE RESTRICT,
  care_date date NOT NULL,
  fed_at timestamptz,
  played_at timestamptz,
  reward_applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dog_id, care_date),
  CONSTRAINT dog_daily_care_reward_complete CHECK (
    reward_applied_at IS NULL OR (fed_at IS NOT NULL AND played_at IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS dog_daily_care_set_updated_at ON dog_daily_care;
CREATE TRIGGER dog_daily_care_set_updated_at
BEFORE UPDATE ON dog_daily_care
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dog_explore_destinations (
  dog_id uuid PRIMARY KEY REFERENCES account_dogs(id) ON DELETE RESTRICT,
  origin_lat double precision NOT NULL CHECK (origin_lat BETWEEN -90 AND 90),
  origin_lon double precision NOT NULL CHECK (origin_lon BETWEEN -180 AND 180),
  destination_lat double precision NOT NULL CHECK (destination_lat BETWEEN -90 AND 90),
  destination_lon double precision NOT NULL CHECK (destination_lon BETWEEN -180 AND 180),
  distance_m double precision NOT NULL CHECK (distance_m >= 0),
  discovered_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS dog_explore_destinations_set_updated_at ON dog_explore_destinations;
CREATE TRIGGER dog_explore_destinations_set_updated_at
BEFORE UPDATE ON dog_explore_destinations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE player_pets IS
  'Deprecated legacy Echo pet storage. Active Pet Chamber behavior uses account_dogs.';
COMMENT ON TABLE pet_expeditions IS
  'Deprecated legacy Echo expedition storage. No active client or websocket route uses it.';
