CREATE TABLE IF NOT EXISTS specialization_ultimate_completion_identities (
  completion_identity text PRIMARY KEY CHECK (length(completion_identity) BETWEEN 1 AND 128),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  specialization_id text NOT NULL,
  mastery_quest_id text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, specialization_id, mastery_quest_id, completion_identity),
  CHECK ((specialization_id, mastery_quest_id) IN (
    ('warrior', 'warrior_mastery_trial'),
    ('knight', 'knight_mastery_trial'),
    ('legionnaire', 'legionnaire_mastery_trial'),
    ('ranger', 'ranger_mastery_trial'),
    ('mercenary', 'mercenary_mastery_trial'),
    ('sentinel', 'sentinel_mastery_trial'),
    ('assassin', 'assassin_mastery_trial'),
    ('ninja', 'ninja_mastery_trial'),
    ('monk', 'monk_mastery_trial'),
    ('rogue', 'rogue_mastery_trial'),
    ('druid', 'druid_mastery_trial'),
    ('merchant', 'merchant_mastery_trial'),
    ('artificer', 'artificer_mastery_trial'),
    ('voyager', 'voyager_mastery_trial'),
    ('paladin', 'paladin_mastery_trial'),
    ('cleric', 'cleric_mastery_trial')
  ))
);

CREATE TABLE IF NOT EXISTS player_specialization_ultimate_unlocks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  specialization_id text NOT NULL,
  mastery_quest_id text NOT NULL,
  completion_identity text NOT NULL UNIQUE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, specialization_id),
  FOREIGN KEY (player_id, specialization_id, mastery_quest_id, completion_identity)
    REFERENCES specialization_ultimate_completion_identities (
      player_id, specialization_id, mastery_quest_id, completion_identity
    ) ON DELETE RESTRICT
);

COMMENT ON TABLE player_specialization_ultimate_unlocks IS
  'Trusted durable Mastery Trial completions that unlock implemented specialization Ultimates. Completion survives skill reset and respec.';
COMMENT ON TABLE specialization_ultimate_completion_identities IS
  'Durable first-target binding for trusted Mastery Trial completion identities, including identities rejected because that target was already complete.';
