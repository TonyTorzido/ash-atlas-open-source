-- Persistent Population v2 is deployed dark. Every live rollout change is
-- serialized, bounded by application boot policy, and audited in this
-- transaction. A selected zone points at one exact immutable plan identity.

CREATE TABLE population_v2_rollout_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'disabled' CHECK (
    mode IN (
      'disabled',
      'shadow',
      'developer-selected-zone',
      'selected-zone',
      'enabled'
    )
  ),
  selected_plan_id uuid NULL,
  selected_zone_id text NULL,
  selected_geometry_version text NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  updated_by_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  updated_by_release_sha text NULL CHECK (
    updated_by_release_sha IS NULL OR updated_by_release_sha ~ '^[a-f0-9]{40}$'
  ),
  change_reason text NOT NULL DEFAULT 'schema_default' CHECK (
    char_length(change_reason) BETWEEN 1 AND 240
    AND change_reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT population_v2_rollout_selection_shape CHECK (
    (
      mode IN ('developer-selected-zone', 'selected-zone')
      AND selected_plan_id IS NOT NULL
      AND selected_zone_id IS NOT NULL
      AND selected_geometry_version IS NOT NULL
    )
    OR (
      mode IN ('disabled', 'shadow', 'enabled')
      AND selected_plan_id IS NULL
      AND selected_zone_id IS NULL
      AND selected_geometry_version IS NULL
    )
  ),
  CONSTRAINT population_v2_rollout_selected_plan_fk
    FOREIGN KEY (
      selected_plan_id,
      selected_zone_id,
      selected_geometry_version
    )
    REFERENCES population_zones_v2 (
      plan_id,
      zone_id,
      geometry_version
    )
    ON DELETE RESTRICT
);

INSERT INTO population_v2_rollout_control (singleton)
VALUES (true);

CREATE TABLE population_v2_rollout_audit (
  audit_id bigserial PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  operator_account_id uuid NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  operator_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  prior_mode text NULL CHECK (
    prior_mode IS NULL OR prior_mode IN (
      'disabled',
      'shadow',
      'developer-selected-zone',
      'selected-zone',
      'enabled'
    )
  ),
  resulting_mode text NOT NULL CHECK (
    resulting_mode IN (
      'disabled',
      'shadow',
      'developer-selected-zone',
      'selected-zone',
      'enabled'
    )
  ),
  prior_selection jsonb NULL CHECK (
    prior_selection IS NULL OR jsonb_typeof(prior_selection) = 'object'
  ),
  resulting_selection jsonb NULL CHECK (
    resulting_selection IS NULL OR jsonb_typeof(resulting_selection) = 'object'
  ),
  prior_revision bigint NULL CHECK (prior_revision IS NULL OR prior_revision >= 0),
  resulting_revision bigint NOT NULL CHECK (resulting_revision >= 0),
  release_sha text NULL CHECK (
    release_sha IS NULL OR release_sha ~ '^[a-f0-9]{40}$'
  ),
  reason text NOT NULL CHECK (
    char_length(reason) BETWEEN 1 AND 240
    AND reason !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX population_v2_rollout_audit_created_idx
  ON population_v2_rollout_audit (created_at DESC, audit_id DESC);

INSERT INTO population_v2_rollout_audit (
  operation_id,
  operator_account_id,
  operator_player_id,
  prior_mode,
  resulting_mode,
  prior_selection,
  resulting_selection,
  prior_revision,
  resulting_revision,
  release_sha,
  reason
) VALUES (
  '00000000-0000-4000-8000-000000000652',
  NULL,
  NULL,
  NULL,
  'disabled',
  NULL,
  NULL,
  NULL,
  0,
  NULL,
  'schema_default'
);

CREATE OR REPLACE FUNCTION population_v2_rollout_selection(
  plan_id uuid,
  zone_id text,
  geometry_version text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN plan_id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'planId', plan_id,
      'zoneId', zone_id,
      'geometryVersion', geometry_version
    )
  END
$$;

CREATE OR REPLACE FUNCTION guard_population_v2_rollout_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_id_text text := nullif(
    current_setting('ash_atlas.population_v2_operation_id', true), ''
  );
  operator_account_text text := nullif(
    current_setting('ash_atlas.population_v2_operator_account_id', true), ''
  );
  operator_player_id text := nullif(
    current_setting('ash_atlas.population_v2_operator_player_id', true), ''
  );
  change_reason text := nullif(
    current_setting('ash_atlas.population_v2_change_reason', true), ''
  );
  release_sha text := nullif(
    current_setting('ash_atlas.population_v2_release_sha', true), ''
  );
  operation_id uuid;
  operator_account_id uuid;
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton THEN
    RAISE EXCEPTION 'population v2 rollout singleton identity cannot change';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'population v2 rollout revision must advance exactly once';
  END IF;
  IF operation_id_text IS NULL OR operator_account_text IS NULL
     OR operator_player_id IS NULL OR change_reason IS NULL THEN
    RAISE EXCEPTION 'population v2 rollout change requires audited operator context';
  END IF;

  operation_id := operation_id_text::uuid;
  operator_account_id := operator_account_text::uuid;
  IF char_length(change_reason) > 240 OR change_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'population v2 rollout reason is invalid';
  END IF;
  IF release_sha IS NOT NULL AND release_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'population v2 rollout release SHA is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM players
    WHERE id = operator_player_id
      AND account_id = operator_account_id
  ) THEN
    RAISE EXCEPTION 'population v2 rollout operator identity is invalid';
  END IF;
  IF NEW.updated_by_account_id IS DISTINCT FROM operator_account_id
     OR NEW.updated_by_player_id IS DISTINCT FROM operator_player_id
     OR NEW.updated_by_release_sha IS DISTINCT FROM release_sha
     OR NEW.change_reason IS DISTINCT FROM change_reason THEN
    RAISE EXCEPTION 'population v2 rollout row does not match audited operator context';
  END IF;

  INSERT INTO population_v2_rollout_audit (
    operation_id,
    operator_account_id,
    operator_player_id,
    prior_mode,
    resulting_mode,
    prior_selection,
    resulting_selection,
    prior_revision,
    resulting_revision,
    release_sha,
    reason
  ) VALUES (
    operation_id,
    operator_account_id,
    operator_player_id,
    OLD.mode,
    NEW.mode,
    population_v2_rollout_selection(
      OLD.selected_plan_id,
      OLD.selected_zone_id,
      OLD.selected_geometry_version
    ),
    population_v2_rollout_selection(
      NEW.selected_plan_id,
      NEW.selected_zone_id,
      NEW.selected_geometry_version
    ),
    OLD.revision,
    NEW.revision,
    release_sha,
    change_reason
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER population_v2_rollout_change_guard
BEFORE UPDATE ON population_v2_rollout_control
FOR EACH ROW EXECUTE FUNCTION guard_population_v2_rollout_change();

CREATE OR REPLACE FUNCTION prevent_population_v2_rollout_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'population v2 rollout records are protected';
END;
$$;

CREATE TRIGGER population_v2_rollout_control_delete_guard
BEFORE DELETE ON population_v2_rollout_control
FOR EACH ROW EXECUTE FUNCTION prevent_population_v2_rollout_mutation();

CREATE TRIGGER population_v2_rollout_audit_append_only
BEFORE UPDATE OR DELETE ON population_v2_rollout_audit
FOR EACH ROW EXECUTE FUNCTION prevent_population_v2_rollout_mutation();

COMMENT ON TABLE population_v2_rollout_control IS
  'Singleton durable Population v2 rollout state. The static boot setting is only a ceiling.';
COMMENT ON COLUMN population_v2_rollout_control.mode IS
  'developer-selected-zone authorizes one developer-initiated physical zone cutover; it never selects a population version per viewer.';
COMMENT ON TABLE population_v2_rollout_audit IS
  'Append-only, transaction-coupled audit for every Population v2 rollout mutation.';
