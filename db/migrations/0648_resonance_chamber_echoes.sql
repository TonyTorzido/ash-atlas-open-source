ALTER TABLE player_pets
  ADD COLUMN generator_version integer,
  ADD COLUMN seed_fingerprint text,
  ADD COLUMN echo_signature text,
  ADD COLUMN appearance_fingerprint text,
  ADD COLUMN collision_nonce integer,
  ADD COLUMN character_name_seed_snapshot text,
  ADD COLUMN adopted_at_mountain_local text,
  ADD COLUMN completed_at_mountain_local text,
  ADD COLUMN generated_blueprint_json jsonb,
  ADD COLUMN innate_disposition text,
  ADD COLUMN quirk_key text,
  ADD COLUMN secondary_personality_trait text,
  ADD COLUMN personality_tie_order jsonb,
  ADD COLUMN strange_object_key text,
  ADD COLUMN chamber_affinity text,
  ADD COLUMN last_meaningful_visit_date date;

UPDATE player_pets p
SET generator_version = 0,
    seed_fingerprint = md5('legacy-seed:' || p.id::text)
      || md5('legacy-seed-2:' || p.id::text),
    echo_signature = upper(substr(md5('legacy-signature:' || p.id::text), 1, 4)
      || '-' || substr(md5('legacy-signature:' || p.id::text), 5, 4)),
    appearance_fingerprint = md5('legacy-appearance:' || p.id::text)
      || md5('legacy-appearance-2:' || p.id::text),
    collision_nonce = 0,
    character_name_seed_snapshot = lower(btrim(pl.username)),
    adopted_at_mountain_local = to_char(
      p.adopted_at AT TIME ZONE 'America/Denver',
      'YYYY-MM-DD"T"HH24:MI:SS.MS'
    ) || '[America/Denver]',
    completed_at_mountain_local = CASE WHEN p.completed_at IS NULL THEN NULL ELSE
      to_char(p.completed_at AT TIME ZONE 'America/Denver', 'YYYY-MM-DD"T"HH24:MI:SS.MS')
      || '[America/Denver]' END,
    generated_blueprint_json = jsonb_build_object(
      'schemaVersion', 1,
      'species', p.species,
      'phenotype', jsonb_build_object(
        'bodyBuild', 'legacy-form', 'proportions', 'legacy-proportions',
        'primaryColor', CASE p.species WHEN 'emberhorn_whelp' THEN '#49352f'
          WHEN 'gloam_hare' THEN '#4b4c46' ELSE '#3a3e40' END,
        'secondaryColor', CASE p.species WHEN 'emberhorn_whelp' THEN '#765142'
          WHEN 'gloam_hare' THEN '#7b7a6b' ELSE '#656a68' END,
        'markingTopology', 'legacy-mark', 'markingDensity', 'sparse',
        'markingSymmetry', 'balanced', 'eyeColor', 'moss-green',
        'eyeShape', 'round', 'glowIntensity', 'faint',
        'glowVeinPattern', 'brow-branches', 'radiationHue', 'moss-green',
        'speciesFeature', 'legacy-feature', 'tailShape', 'legacy-tail',
        'posture', 'forward-curious', 'smallAsymmetry', 'one-pale-toe'
      ),
      'behavior', jsonb_build_object(
        'gait', 'measured', 'idleMovement', 'watches-chamber',
        'sleepPosition', 'curled', 'voicePitch', 'middle', 'voiceTexture', 'soft-rough'
      ),
      'identity', jsonb_build_object(
        'innateDisposition', 'Gentle', 'quirkKey',
          CASE p.species WHEN 'emberhorn_whelp' THEN 'hoards_bent_metal'
            WHEN 'gloam_hare' THEN 'collects_loose_thread' ELSE 'carries_damaged_toy' END,
        'quirkParameter', 'legacy', 'chamberAffinity', 'old-wood',
        'artifactMotif', 'bent-metal', 'adultMutation', 'legacy-continuation',
        'reactionOrder', jsonb_build_array(0, 1, 2, 3, 4),
        'traitTieOrder', jsonb_build_array('pet', 'play', 'groom', 'tell_story', 'let_rest')
      )
    ),
    innate_disposition = 'Gentle',
    quirk_key = CASE p.species WHEN 'emberhorn_whelp' THEN 'hoards_bent_metal'
      WHEN 'gloam_hare' THEN 'collects_loose_thread' ELSE 'carries_damaged_toy' END,
    secondary_personality_trait = CASE WHEN p.status = 'completed' THEN
      CASE WHEN p.personality_trait = 'Affectionate' THEN 'Energetic' ELSE 'Affectionate' END
      ELSE NULL END,
    personality_tie_order = '["pet","play","groom","tell_story","let_rest"]'::jsonb,
    chamber_affinity = 'old-wood'
FROM players pl
WHERE pl.id = p.player_id;

ALTER TABLE player_pets
  ALTER COLUMN generator_version SET NOT NULL,
  ALTER COLUMN seed_fingerprint SET NOT NULL,
  ALTER COLUMN echo_signature SET NOT NULL,
  ALTER COLUMN appearance_fingerprint SET NOT NULL,
  ALTER COLUMN collision_nonce SET NOT NULL,
  ALTER COLUMN character_name_seed_snapshot SET NOT NULL,
  ALTER COLUMN adopted_at_mountain_local SET NOT NULL,
  ALTER COLUMN generated_blueprint_json SET NOT NULL,
  ALTER COLUMN innate_disposition SET NOT NULL,
  ALTER COLUMN quirk_key SET NOT NULL,
  ALTER COLUMN personality_tie_order SET NOT NULL,
  ALTER COLUMN chamber_affinity SET NOT NULL,
  ADD CONSTRAINT player_pets_generator_version_check CHECK (generator_version BETWEEN 0 AND 2147483647),
  ADD CONSTRAINT player_pets_seed_fingerprint_check CHECK (seed_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT player_pets_echo_signature_check CHECK (echo_signature ~ '^[A-F0-9]{4}-[A-F0-9]{4}$'),
  ADD CONSTRAINT player_pets_appearance_fingerprint_check CHECK (appearance_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT player_pets_collision_nonce_check CHECK (collision_nonce BETWEEN 0 AND 31),
  ADD CONSTRAINT player_pets_seed_name_check CHECK (char_length(character_name_seed_snapshot) BETWEEN 1 AND 80),
  ADD CONSTRAINT player_pets_blueprint_object_check CHECK (jsonb_typeof(generated_blueprint_json) = 'object'),
  ADD CONSTRAINT player_pets_disposition_check CHECK (
    innate_disposition IN ('Cautious', 'Bold', 'Gentle', 'Mischievous', 'Solemn', 'Watchful', 'Stubborn', 'Excitable')
  ),
  ADD CONSTRAINT player_pets_secondary_trait_check CHECK (
    secondary_personality_trait IS NULL
    OR secondary_personality_trait IN ('Affectionate', 'Energetic', 'Regal', 'Curious', 'Calm')
  ),
  ADD CONSTRAINT player_pets_trait_order_check CHECK (
    jsonb_typeof(personality_tie_order) = 'array'
    AND jsonb_array_length(personality_tie_order) = 5
  );

ALTER TABLE player_pets DROP CONSTRAINT player_pets_completion_state;
ALTER TABLE player_pets ADD CONSTRAINT player_pets_completion_state CHECK (
  (
    status = 'active' AND care_days < 30 AND completed_at IS NULL
    AND completed_at_mountain_local IS NULL
    AND personality_trait IS NULL AND secondary_personality_trait IS NULL
  )
  OR
  (
    status = 'completed' AND care_days = 30 AND completed_at IS NOT NULL
    AND completed_at_mountain_local IS NOT NULL
    AND personality_trait IS NOT NULL AND secondary_personality_trait IS NOT NULL
    AND personality_trait <> secondary_personality_trait
  )
);

CREATE UNIQUE INDEX player_pets_echo_signature_unique
  ON player_pets (echo_signature);

CREATE UNIQUE INDEX player_pets_appearance_fingerprint_unique
  ON player_pets (appearance_fingerprint);

ALTER TABLE pet_daily_care
  ADD COLUMN real_created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN debug_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN debug_operation_id uuid;

ALTER TABLE pet_milestones DROP CONSTRAINT pet_milestones_milestone_key_check;
ALTER TABLE pet_milestones DROP CONSTRAINT pet_milestones_care_day_check;
ALTER TABLE pet_milestones
  ADD COLUMN effective_pet_date date,
  ADD COLUMN content_key text,
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT pet_milestones_milestone_key_check CHECK (
    milestone_key IN (
      'awakening', 'recognition', 'first_growth', 'strange_object',
      'individual_behavior', 'chamber_change', 'understanding', 'adult_ceremony'
    )
  ),
  ADD CONSTRAINT pet_milestones_care_day_check CHECK (care_day IN (1, 3, 7, 10, 14, 21, 25, 30)),
  ADD CONSTRAINT pet_milestones_metadata_check CHECK (jsonb_typeof(metadata) = 'object');

UPDATE pet_milestones
SET effective_pet_date = unlocked_at AT TIME ZONE 'America/Denver',
    content_key = 'legacy.milestone.' || milestone_key;

ALTER TABLE pet_milestones
  ALTER COLUMN effective_pet_date SET NOT NULL,
  ALTER COLUMN content_key SET NOT NULL;

CREATE TABLE pet_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id uuid NOT NULL REFERENCES player_pets(id) ON DELETE CASCADE,
  memory_type text NOT NULL CHECK (
    memory_type IN ('adoption', 'daily_growth', 'absence_return', 'milestone', 'adult_ceremony')
  ),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 160),
  care_day smallint NOT NULL CHECK (care_day BETWEEN 0 AND 30),
  effective_pet_date date NOT NULL,
  real_created_at timestamptz NOT NULL DEFAULT now(),
  content_key text NOT NULL CHECK (char_length(content_key) BETWEEN 1 AND 160),
  rendered_text text NOT NULL CHECK (char_length(rendered_text) BETWEEN 1 AND 1000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  importance smallint NOT NULL DEFAULT 1 CHECK (importance BETWEEN 1 AND 5),
  UNIQUE (pet_id, source_key)
);

CREATE INDEX pet_memories_pet_history
  ON pet_memories (pet_id, care_day, real_created_at, id);

INSERT INTO pet_memories (
  pet_id, memory_type, source_key, care_day, effective_pet_date,
  real_created_at, content_key, rendered_text, metadata, importance
)
SELECT pet_id, 'milestone', 'legacy-milestone:' || milestone_key, care_day,
       effective_pet_date, unlocked_at, content_key, journal_text,
       jsonb_build_object('milestoneKey', milestone_key), 3
FROM pet_milestones
ON CONFLICT (pet_id, source_key) DO NOTHING;

CREATE TABLE pet_debug_offsets (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  offset_days integer NOT NULL DEFAULT 0 CHECK (offset_days BETWEEN 0 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_identity text NOT NULL CHECK (char_length(updated_by_identity) BETWEEN 1 AND 200)
);

CREATE TABLE pet_view_preferences (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  viewed_pet_id uuid REFERENCES player_pets(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pet_debug_operations (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  action text NOT NULL CHECK (
    action IN (
      'advance_1_day', 'advance_7_days', 'complete_today', 'complete_and_advance',
      'simulate_7_days', 'jump_next_milestone', 'jump_adult', 'clear_offset', 'reset'
    )
  ),
  result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, operation_id)
);

CREATE TABLE pet_owner_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  account_identity text NOT NULL CHECK (char_length(account_identity) BETWEEN 1 AND 200),
  player_id text NOT NULL,
  player_name text NOT NULL CHECK (char_length(player_name) BETWEEN 1 AND 80),
  operation_id uuid NOT NULL,
  action text NOT NULL,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_metadata) = 'object'),
  result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, operation_id, action)
);

CREATE INDEX pet_owner_audit_events_account_created
  ON pet_owner_audit_events (account_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_pet_owner_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'pet owner audit events are append-only';
END;
$$;

CREATE TRIGGER pet_owner_audit_events_append_only
BEFORE UPDATE OR DELETE ON pet_owner_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_pet_owner_audit_mutation();
