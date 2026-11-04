ALTER TABLE pet_memories DROP CONSTRAINT pet_memories_memory_type_check;
ALTER TABLE pet_memories ADD CONSTRAINT pet_memories_memory_type_check CHECK (
  memory_type IN (
    'adoption', 'daily_growth', 'absence_return', 'milestone', 'adult_ceremony',
    'expedition', 'expedition_injury', 'expedition_level', 'expedition_lore',
    'expedition_healing'
  )
);

CREATE TABLE pet_expedition_profiles (
  pet_id uuid PRIMARY KEY REFERENCES player_pets(id) ON DELETE CASCADE,
  expedition_level smallint NOT NULL DEFAULT 1 CHECK (expedition_level BETWEEN 1 AND 10),
  expedition_xp integer NOT NULL DEFAULT 0 CHECK (expedition_xp BETWEEN 0 AND 1000000),
  earned_training_points smallint NOT NULL DEFAULT 0 CHECK (earned_training_points BETWEEN 0 AND 3),
  unspent_training_points smallint NOT NULL DEFAULT 0 CHECK (unspent_training_points BETWEEN 0 AND 3),
  vigor smallint NOT NULL CHECK (vigor BETWEEN 1 AND 10),
  instinct smallint NOT NULL CHECK (instinct BETWEEN 1 AND 10),
  scavenging smallint NOT NULL CHECK (scavenging BETWEEN 1 AND 10),
  agility smallint NOT NULL CHECK (agility BETWEEN 1 AND 10),
  resonance smallint NOT NULL CHECK (resonance BETWEEN 1 AND 10),
  current_health smallint NOT NULL CHECK (current_health BETWEEN 0 AND 100),
  fatigue smallint NOT NULL DEFAULT 0 CHECK (fatigue BETWEEN 0 AND 100),
  fatigue_updated_at timestamptz NOT NULL DEFAULT now(),
  active_injury_key text CHECK (
    active_injury_key IS NULL OR active_injury_key IN (
      'scraped_paw', 'singed_fur', 'strained_leg', 'radiation_irritation',
      'exhaustion', 'frightened', 'temporal_disorientation'
    )
  ),
  injury_started_at timestamptz,
  injury_recovery_at timestamptz,
  last_treatment_at timestamptz,
  total_expeditions integer NOT NULL DEFAULT 0 CHECK (total_expeditions >= 0),
  successful_expeditions integer NOT NULL DEFAULT 0 CHECK (successful_expeditions >= 0),
  emergency_recalls integer NOT NULL DEFAULT 0 CHECK (emergency_recalls >= 0),
  materials_found integer NOT NULL DEFAULT 0 CHECK (materials_found >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_expedition_profile_stat_budget CHECK (
    vigor + instinct + scavenging + agility + resonance
      = 15 + earned_training_points - unspent_training_points
  ),
  CONSTRAINT pet_expedition_profile_training_points CHECK (
    unspent_training_points <= earned_training_points
  ),
  CONSTRAINT pet_expedition_profile_injury_state CHECK (
    (
      active_injury_key IS NULL AND injury_started_at IS NULL
      AND injury_recovery_at IS NULL
    ) OR (
      active_injury_key IS NOT NULL AND injury_started_at IS NOT NULL
      AND injury_recovery_at IS NOT NULL
      AND injury_recovery_at > injury_started_at
    )
  )
);

CREATE TABLE pet_expedition_preferences (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  selected_pet_id uuid REFERENCES player_pets(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pet_expedition_training_choices (
  pet_id uuid NOT NULL REFERENCES player_pets(id) ON DELETE CASCADE,
  unlocked_at_level smallint NOT NULL CHECK (unlocked_at_level IN (2, 4, 7)),
  stat_key text NOT NULL CHECK (
    stat_key IN ('vigor', 'instinct', 'scavenging', 'agility', 'resonance')
  ),
  amount smallint NOT NULL DEFAULT 1 CHECK (amount = 1),
  chosen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pet_id, unlocked_at_level)
);

CREATE TABLE pet_expeditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  pet_id uuid NOT NULL REFERENCES player_pets(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (
    status IN ('active', 'awaiting_acknowledgement', 'claimed')
  ),
  destination_key text NOT NULL CHECK (
    destination_key IN ('shattered_orchard', 'bonefield_warrens', 'fallen_foundry')
  ),
  duration_key text NOT NULL CHECK (
    duration_key IN ('training_5m', 'scouting_15m', 'supply_1h', 'deep_4h', 'long_8h')
  ),
  directive_key text NOT NULL CHECK (
    directive_key IN ('return_safely', 'search_materials', 'follow_signal')
  ),
  generator_version integer NOT NULL CHECK (generator_version BETWEEN 1 AND 2147483647),
  seed_fingerprint text NOT NULL CHECK (seed_fingerprint ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  starting_profile_json jsonb NOT NULL CHECK (jsonb_typeof(starting_profile_json) = 'object'),
  result_json jsonb CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object'),
  forced_scenario text,
  resource_settlement_key text NOT NULL UNIQUE,
  resource_settled_at timestamptz,
  xp_settled_at timestamptz,
  injury_settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_expedition_time_order CHECK (completes_at > started_at),
  CONSTRAINT pet_expedition_resolution_state CHECK (
    (
      status = 'active' AND resolved_at IS NULL AND acknowledged_at IS NULL
      AND result_json IS NULL AND resource_settled_at IS NULL
      AND xp_settled_at IS NULL AND injury_settled_at IS NULL
    ) OR (
      status = 'awaiting_acknowledgement' AND resolved_at IS NOT NULL
      AND acknowledged_at IS NULL AND result_json IS NOT NULL
      AND resource_settled_at IS NOT NULL AND xp_settled_at IS NOT NULL
      AND injury_settled_at IS NOT NULL
    ) OR (
      status = 'claimed' AND resolved_at IS NOT NULL
      AND acknowledged_at IS NOT NULL AND result_json IS NOT NULL
      AND resource_settled_at IS NOT NULL AND xp_settled_at IS NOT NULL
      AND injury_settled_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX pet_expeditions_one_unfinished_character
  ON pet_expeditions (player_id)
  WHERE status IN ('active', 'awaiting_acknowledgement');

CREATE INDEX pet_expeditions_player_history
  ON pet_expeditions (player_id, started_at DESC, id);

CREATE TABLE pet_expedition_discoveries (
  pet_id uuid NOT NULL REFERENCES player_pets(id) ON DELETE CASCADE,
  discovery_key text NOT NULL CHECK (char_length(discovery_key) BETWEEN 1 AND 160),
  first_expedition_id uuid NOT NULL REFERENCES pet_expeditions(id) ON DELETE CASCADE,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (pet_id, discovery_key)
);

CREATE TABLE pet_expedition_debug_operations (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  action text NOT NULL CHECK (
    action IN (
      'complete_now', 'force_safe', 'force_minor_injury', 'force_major_injury',
      'force_no_materials', 'force_rare_lore', 'grant_xp', 'set_level',
      'clear_active', 'heal', 'clear_fatigue', 'reset_expedition_progress'
    )
  ),
  result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, operation_id)
);
