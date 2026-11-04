ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS test_access_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS test_access_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS test_access_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS test_access_decided_by_account_id uuid NULL,
  ADD COLUMN IF NOT EXISTS test_access_decision_note text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'accounts'::regclass
      AND conname = 'accounts_test_access_status_valid'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_test_access_status_valid
      CHECK (test_access_status IN ('pending', 'approved', 'denied', 'revoked'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'accounts'::regclass
      AND conname = 'accounts_test_access_decided_by_fkey'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_test_access_decided_by_fkey
      FOREIGN KEY (test_access_decided_by_account_id)
      REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
DECLARE
  backfilled_count integer;
BEGIN
  UPDATE accounts
  SET test_access_status = 'approved',
      test_access_requested_at = created_at,
      test_access_decided_at = COALESCE(test_access_decided_at, now()),
      test_access_decision_note = COALESCE(
        test_access_decision_note,
        'Approved by closed-test gate migration 0680'
      )
  WHERE test_access_requested_at IS NULL;
  GET DIAGNOSTICS backfilled_count = ROW_COUNT;
  RAISE NOTICE '0680 closed-test existing accounts backfilled approved: %', backfilled_count;
END
$$;

ALTER TABLE accounts
  ALTER COLUMN test_access_status SET NOT NULL,
  ALTER COLUMN test_access_status SET DEFAULT 'pending',
  ALTER COLUMN test_access_requested_at SET NOT NULL,
  ALTER COLUMN test_access_requested_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS accounts_test_access_pending_idx
  ON accounts (test_access_requested_at, id)
  WHERE test_access_status = 'pending';
CREATE INDEX IF NOT EXISTS accounts_test_access_status_idx
  ON accounts (test_access_status, created_at, id);

ALTER TABLE account_identities
  ADD COLUMN IF NOT EXISTS email_normalized text;

UPDATE account_identities
SET email_normalized = lower(btrim(email))
WHERE email_normalized IS NULL;

ALTER TABLE account_identities
  ALTER COLUMN email_normalized SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'account_identities'::regclass
      AND conname = 'account_identities_email_normalized_valid'
  ) THEN
    ALTER TABLE account_identities
      ADD CONSTRAINT account_identities_email_normalized_valid
      CHECK (
        email_normalized = lower(btrim(email_normalized))
        AND char_length(email_normalized) BETWEEN 3 AND 320
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS account_identities_verified_email_idx
  ON account_identities (email_normalized, account_id)
  WHERE provider = 'google' AND email_verified = true;

CREATE TABLE IF NOT EXISTS test_access_email_grants (
  id uuid PRIMARY KEY,
  email_display text NOT NULL
    CHECK (email_display = btrim(email_display) AND char_length(email_display) BETWEEN 3 AND 320),
  email_normalized text NOT NULL
    CHECK (
      email_normalized = lower(btrim(email_normalized))
      AND char_length(email_normalized) BETWEEN 3 AND 320
    ),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'claimed', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  claimed_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  claimed_google_subject text NULL,
  claimed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT test_access_email_grants_state_valid CHECK (
    (
      status = 'active'
      AND claimed_account_id IS NULL
      AND claimed_google_subject IS NULL
      AND claimed_at IS NULL
      AND revoked_at IS NULL
    )
    OR
    (
      status = 'claimed'
      AND claimed_account_id IS NOT NULL
      AND claimed_google_subject IS NOT NULL
      AND claimed_at IS NOT NULL
      AND revoked_at IS NULL
    )
    OR
    (
      status = 'revoked'
      AND claimed_account_id IS NULL
      AND claimed_google_subject IS NULL
      AND claimed_at IS NULL
      AND revoked_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS test_access_email_grants_email_unique
  ON test_access_email_grants (email_normalized);
CREATE UNIQUE INDEX IF NOT EXISTS test_access_email_grants_claimed_account_unique
  ON test_access_email_grants (claimed_account_id)
  WHERE claimed_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS test_access_email_grants_status_created_idx
  ON test_access_email_grants (status, created_at, id);

CREATE TABLE IF NOT EXISTS test_access_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN (
    'pending_requested',
    'preapproval_created',
    'preapproval_claimed',
    'preapproval_revoked',
    'account_approved',
    'account_denied',
    'account_revoked',
    'account_restored',
    'bootstrap_admin_approved',
    'development_auto_approved',
    'unauthorized_admin_rejected',
    'existing_account_backfilled'
  )),
  acting_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  target_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  grant_id uuid NULL REFERENCES test_access_email_grants(id) ON DELETE SET NULL,
  previous_status text NULL,
  new_status text NULL,
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 1000),
  runtime_release_sha text NULL,
  operation_key text NULL CHECK (operation_key IS NULL OR char_length(operation_key) <= 255),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS test_access_events_operation_unique
  ON test_access_events (event_type, operation_key)
  WHERE operation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS test_access_events_target_created_idx
  ON test_access_events (target_account_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS test_access_events_type_created_idx
  ON test_access_events (event_type, created_at DESC, id);

INSERT INTO test_access_events (
  id, event_type, target_account_id, previous_status, new_status,
  reason, operation_key, created_at
)
SELECT
  gen_random_uuid(),
  'existing_account_backfilled',
  id,
  NULL,
  'approved',
  'Approved by closed-test gate migration 0680',
  'migration:0680:' || id::text,
  COALESCE(test_access_decided_at, now())
FROM accounts
WHERE test_access_decision_note = 'Approved by closed-test gate migration 0680'
ON CONFLICT (event_type, operation_key) WHERE operation_key IS NOT NULL DO NOTHING;

CREATE OR REPLACE FUNCTION personal_flag_color_hex(color_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE color_name
    WHEN 'red' THEN '#d83a3a'
    WHEN 'blue' THEN '#3366cc'
    WHEN 'green' THEN '#22a447'
    WHEN 'gold' THEN '#c58a16'
    WHEN 'purple' THEN '#7c3aed'
    ELSE NULL
  END
$$;

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS personal_flag_color text,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS initial_spawn_latitude double precision,
  ADD COLUMN IF NOT EXISTS initial_spawn_longitude double precision,
  ADD COLUMN IF NOT EXISTS initial_spawn_algorithm_version text,
  ADD COLUMN IF NOT EXISTS initial_spawn_land_mask_version text,
  ADD COLUMN IF NOT EXISTS initial_spawn_world_identity text,
  ADD COLUMN IF NOT EXISTS initial_spawn_rejected_candidates integer,
  ADD COLUMN IF NOT EXISTS initial_spawn_assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS initial_spawn_state_code text;

UPDATE players
SET personal_flag_color = CASE lower(display_color)
      WHEN '#d83a3a' THEN 'red'
      WHEN '#3366cc' THEN 'blue'
      WHEN '#22a447' THEN 'green'
      WHEN '#c58a16' THEN 'gold'
      WHEN '#7c3aed' THEN 'purple'
      ELSE 'blue'
    END,
    onboarding_completed_at = COALESCE(onboarding_completed_at, created_at),
    initial_spawn_latitude = COALESCE(initial_spawn_latitude, lat),
    initial_spawn_longitude = COALESCE(initial_spawn_longitude, lon),
    initial_spawn_algorithm_version = COALESCE(
      initial_spawn_algorithm_version,
      'legacy-existing-v1'
    ),
    initial_spawn_land_mask_version = COALESCE(
      initial_spawn_land_mask_version,
      'legacy-persisted'
    ),
    initial_spawn_world_identity = COALESCE(initial_spawn_world_identity, 'legacy'),
    initial_spawn_rejected_candidates = COALESCE(initial_spawn_rejected_candidates, 0),
    initial_spawn_assigned_at = COALESCE(initial_spawn_assigned_at, created_at),
    initial_spawn_state_code = COALESCE(initial_spawn_state_code, region_code)
WHERE personal_flag_color IS NULL
   OR onboarding_completed_at IS NULL
   OR initial_spawn_latitude IS NULL
   OR initial_spawn_longitude IS NULL
   OR initial_spawn_algorithm_version IS NULL
   OR initial_spawn_land_mask_version IS NULL
   OR initial_spawn_world_identity IS NULL
   OR initial_spawn_rejected_candidates IS NULL
   OR initial_spawn_assigned_at IS NULL;

CREATE OR REPLACE FUNCTION fill_legacy_player_onboarding_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.personal_flag_color := COALESCE(NEW.personal_flag_color, 'blue');
  NEW.onboarding_completed_at := COALESCE(NEW.onboarding_completed_at, NEW.created_at, now());
  NEW.initial_spawn_latitude := COALESCE(NEW.initial_spawn_latitude, NEW.lat);
  NEW.initial_spawn_longitude := COALESCE(NEW.initial_spawn_longitude, NEW.lon);
  NEW.initial_spawn_algorithm_version := COALESCE(
    NEW.initial_spawn_algorithm_version,
    'legacy-direct-insert-v1'
  );
  NEW.initial_spawn_land_mask_version := COALESCE(
    NEW.initial_spawn_land_mask_version,
    'legacy-persisted'
  );
  NEW.initial_spawn_world_identity := COALESCE(NEW.initial_spawn_world_identity, 'legacy');
  NEW.initial_spawn_rejected_candidates := COALESCE(NEW.initial_spawn_rejected_candidates, 0);
  NEW.initial_spawn_assigned_at := COALESCE(NEW.initial_spawn_assigned_at, NEW.created_at, now());
  NEW.initial_spawn_state_code := COALESCE(NEW.initial_spawn_state_code, NEW.region_code);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS players_legacy_onboarding_defaults ON players;
CREATE TRIGGER players_legacy_onboarding_defaults
  BEFORE INSERT ON players
  FOR EACH ROW
  EXECUTE FUNCTION fill_legacy_player_onboarding_defaults();

ALTER TABLE players
  ALTER COLUMN personal_flag_color SET NOT NULL,
  ALTER COLUMN onboarding_completed_at SET NOT NULL,
  ALTER COLUMN initial_spawn_latitude SET NOT NULL,
  ALTER COLUMN initial_spawn_longitude SET NOT NULL,
  ALTER COLUMN initial_spawn_algorithm_version SET NOT NULL,
  ALTER COLUMN initial_spawn_land_mask_version SET NOT NULL,
  ALTER COLUMN initial_spawn_world_identity SET NOT NULL,
  ALTER COLUMN initial_spawn_rejected_candidates SET NOT NULL,
  ALTER COLUMN initial_spawn_assigned_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'players'::regclass
      AND conname = 'players_personal_flag_color_valid'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_personal_flag_color_valid
      CHECK (personal_flag_color IN ('red', 'blue', 'green', 'gold', 'purple'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'players'::regclass
      AND conname = 'players_initial_spawn_valid'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_initial_spawn_valid CHECK (
        initial_spawn_latitude BETWEEN -90 AND 90
        AND initial_spawn_longitude BETWEEN -180 AND 180
        AND initial_spawn_rejected_candidates >= 0
        AND char_length(initial_spawn_algorithm_version) BETWEEN 1 AND 64
        AND char_length(initial_spawn_land_mask_version) BETWEEN 1 AND 255
        AND char_length(initial_spawn_world_identity) BETWEEN 1 AND 255
      );
  END IF;
END
$$;

DO $$
DECLARE
  black_personal_count integer;
  incompatible_name_count integer;
BEGIN
  UPDATE flags flag
  SET original_personal_color = personal_flag_color_hex(player.personal_flag_color)
  FROM players player
  WHERE flag.owner_id = player.id
    AND flag.control_type = 'personal'
    AND lower(COALESCE(flag.original_personal_color, '')) IN ('black', '#000', '#000000');
  GET DIAGNOSTICS black_personal_count = ROW_COUNT;

  SELECT count(*) INTO incompatible_name_count
  FROM players
  WHERE username !~ '^[A-Za-z]{3,20}$';

  RAISE NOTICE '0680 legacy black personal flags recolored: %', black_personal_count;
  RAISE NOTICE '0680 legacy names retained outside new-name rules: %', incompatible_name_count;
END
$$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_personal_color_not_black'
  ) THEN
    ALTER TABLE flags
      ADD CONSTRAINT flags_personal_color_not_black CHECK (
        control_type <> 'personal'
        OR original_personal_color IS NULL
        OR lower(original_personal_color) NOT IN ('black', '#000', '#000000')
      );
  END IF;
END
$$;
