-- Four-mode personal flag access, owner-wide Normal passage, owner defaults,
-- and normalized Custom access groups. This is a forward-only expansion of
-- the deployed 0658 access model and does not rewrite wallets or ownership.

ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_access_mode_check;
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_public_toll_gold_check;
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_access_scope_check;

ALTER TABLE flags RENAME COLUMN public_toll_gold TO jump_toll_gold;
ALTER TABLE flags
  ADD COLUMN access_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE flags ADD CONSTRAINT flags_access_mode_check
  CHECK (access_mode IN ('private', 'public', 'normal', 'custom'));
ALTER TABLE flags ADD CONSTRAINT flags_jump_toll_gold_check
  CHECK (jump_toll_gold BETWEEN 0 AND 1000000);
ALTER TABLE flags ADD CONSTRAINT flags_mode_toll_check
  CHECK (access_mode IN ('public', 'normal') OR jump_toll_gold = 0);
ALTER TABLE flags ADD CONSTRAINT flags_access_scope_check CHECK (
  control_type = 'personal'
  OR (access_mode = 'private' AND jump_toll_gold = 0 AND custom_requests_enabled = false)
);

CREATE TABLE custom_flag_access_groups (
  id uuid PRIMARY KEY,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  requests_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX custom_flag_access_groups_owner_idx
  ON custom_flag_access_groups (owner_player_id, created_at, id);
CREATE TRIGGER custom_flag_access_groups_set_updated_at
BEFORE UPDATE ON custom_flag_access_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE player_flag_preferences (
  owner_player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  default_flag_access_mode text NOT NULL DEFAULT 'private'
    CHECK (default_flag_access_mode IN ('private', 'public', 'normal', 'custom')),
  default_public_toll_gold bigint NOT NULL DEFAULT 0
    CHECK (default_public_toll_gold BETWEEN 0 AND 1000000),
  default_normal_toll_gold bigint NOT NULL DEFAULT 0
    CHECK (default_normal_toll_gold BETWEEN 0 AND 1000000),
  default_custom_group_id uuid NULL REFERENCES custom_flag_access_groups(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER player_flag_preferences_set_updated_at
BEFORE UPDATE ON player_flag_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO player_flag_preferences (owner_player_id)
SELECT id FROM players
ON CONFLICT (owner_player_id) DO NOTHING;

CREATE OR REPLACE FUNCTION create_player_flag_preferences() RETURNS trigger AS $$
BEGIN
  INSERT INTO player_flag_preferences (owner_player_id)
  VALUES (NEW.id)
  ON CONFLICT (owner_player_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER players_create_flag_preferences
AFTER INSERT ON players
FOR EACH ROW EXECUTE FUNCTION create_player_flag_preferences();

CREATE TABLE custom_flag_group_memberships (
  flag_id uuid PRIMARY KEY REFERENCES flags(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES custom_flag_access_groups(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX custom_flag_group_memberships_group_idx
  ON custom_flag_group_memberships (group_id, flag_id);
CREATE TRIGGER custom_flag_group_memberships_set_updated_at
BEFORE UPDATE ON custom_flag_group_memberships
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE custom_flag_group_overrides (
  group_id uuid NOT NULL REFERENCES custom_flag_access_groups(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  access_type text NOT NULL CHECK (access_type IN ('allow', 'deny')),
  expires_at timestamptz NULL,
  created_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, player_id)
);
CREATE INDEX custom_flag_group_overrides_active_idx
  ON custom_flag_group_overrides (group_id, expires_at, player_id);
CREATE INDEX custom_flag_group_overrides_expiry_idx
  ON custom_flag_group_overrides (expires_at) WHERE expires_at IS NOT NULL;
CREATE TRIGGER custom_flag_group_overrides_set_updated_at
BEFORE UPDATE ON custom_flag_group_overrides
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE custom_flag_group_requests (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES custom_flag_access_groups(id) ON DELETE CASCADE,
  source_flag_id uuid NULL REFERENCES flags(id) ON DELETE SET NULL,
  requester_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'denied', 'cancelled', 'expired', 'invalidated'
  )),
  create_request_id text NOT NULL CHECK (length(create_request_id) BETWEEN 1 AND 128),
  resolution_request_id text NULL CHECK (
    resolution_request_id IS NULL OR length(resolution_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  CHECK (requester_player_id <> owner_player_id),
  CHECK (expires_at = created_at + interval '24 hours'),
  UNIQUE (requester_player_id, create_request_id),
  CHECK (
    (status = 'pending' AND resolution_request_id IS NULL AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX custom_flag_group_requests_one_pending_idx
  ON custom_flag_group_requests (group_id, requester_player_id)
  WHERE status = 'pending';
CREATE INDEX custom_flag_group_requests_owner_pending_idx
  ON custom_flag_group_requests (owner_player_id, expires_at, id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX custom_flag_group_requests_owner_resolution_idx
  ON custom_flag_group_requests (owner_player_id, resolution_request_id)
  WHERE resolution_request_id IS NOT NULL;
CREATE TRIGGER custom_flag_group_requests_set_updated_at
BEFORE UPDATE ON custom_flag_group_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE normal_flag_passage_grants (
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  grantee_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  granted_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_player_id, grantee_player_id),
  CHECK (owner_player_id <> grantee_player_id),
  CHECK (granted_by_player_id = owner_player_id)
);
CREATE INDEX normal_flag_passage_grants_grantee_idx
  ON normal_flag_passage_grants (grantee_player_id, owner_player_id);
CREATE TRIGGER normal_flag_passage_grants_set_updated_at
BEFORE UPDATE ON normal_flag_passage_grants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE normal_flag_passage_requests (
  id uuid PRIMARY KEY,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  requester_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_flag_id uuid NULL REFERENCES flags(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'denied', 'cancelled', 'expired', 'invalidated'
  )),
  create_request_id text NOT NULL CHECK (length(create_request_id) BETWEEN 1 AND 128),
  resolution_request_id text NULL CHECK (
    resolution_request_id IS NULL OR length(resolution_request_id) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  CHECK (owner_player_id <> requester_player_id),
  CHECK (expires_at = created_at + interval '24 hours'),
  UNIQUE (requester_player_id, create_request_id),
  CHECK (
    (status = 'pending' AND resolution_request_id IS NULL AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX normal_flag_passage_requests_one_pending_idx
  ON normal_flag_passage_requests (owner_player_id, requester_player_id)
  WHERE status = 'pending';
CREATE INDEX normal_flag_passage_requests_owner_pending_idx
  ON normal_flag_passage_requests (owner_player_id, expires_at, id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX normal_flag_passage_requests_owner_resolution_idx
  ON normal_flag_passage_requests (owner_player_id, resolution_request_id)
  WHERE resolution_request_id IS NOT NULL;
CREATE TRIGGER normal_flag_passage_requests_set_updated_at
BEFORE UPDATE ON normal_flag_passage_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deterministic singleton groups preserve every deployed Custom flag's exact
-- current scope. The UUID is stable so a populated migration cannot duplicate it.
WITH singleton AS (
  SELECT f.id AS flag_id, f.owner_id,
         (substr(md5('flag-custom-group:' || f.id::text),1,8) || '-' ||
          substr(md5('flag-custom-group:' || f.id::text),9,4) || '-4' ||
          substr(md5('flag-custom-group:' || f.id::text),14,3) || '-8' ||
          substr(md5('flag-custom-group:' || f.id::text),18,3) || '-' ||
          substr(md5('flag-custom-group:' || f.id::text),21,12))::uuid AS group_id,
         left(COALESCE(NULLIF(btrim(f.name), ''), 'Custom Flag'), 80) AS group_name,
         f.custom_requests_enabled
  FROM flags f
  WHERE f.control_type = 'personal' AND f.access_mode = 'custom'
)
INSERT INTO custom_flag_access_groups (id, owner_player_id, name, requests_enabled)
SELECT group_id, owner_id, group_name, custom_requests_enabled FROM singleton
ON CONFLICT (id) DO NOTHING;

WITH singleton AS (
  SELECT f.id AS flag_id,
         (substr(md5('flag-custom-group:' || f.id::text),1,8) || '-' ||
          substr(md5('flag-custom-group:' || f.id::text),9,4) || '-4' ||
          substr(md5('flag-custom-group:' || f.id::text),14,3) || '-8' ||
          substr(md5('flag-custom-group:' || f.id::text),18,3) || '-' ||
          substr(md5('flag-custom-group:' || f.id::text),21,12))::uuid AS group_id
  FROM flags f
  WHERE f.control_type = 'personal' AND f.access_mode = 'custom'
)
INSERT INTO custom_flag_group_memberships (flag_id, group_id)
SELECT flag_id, group_id FROM singleton
ON CONFLICT (flag_id) DO NOTHING;

INSERT INTO custom_flag_group_overrides (
  group_id, player_id, access_type, expires_at, created_by_player_id, created_at, updated_at
)
SELECT membership.group_id, legacy.player_id, legacy.access_type, legacy.expires_at,
       legacy.created_by_player_id, legacy.created_at, legacy.updated_at
FROM flag_access_overrides legacy
JOIN custom_flag_group_memberships membership ON membership.flag_id = legacy.flag_id
ON CONFLICT (group_id, player_id) DO NOTHING;

INSERT INTO custom_flag_group_requests (
  id, group_id, source_flag_id, requester_player_id, owner_player_id, status,
  create_request_id, resolution_request_id, created_at, updated_at, expires_at, resolved_at
)
SELECT legacy.id, membership.group_id, legacy.flag_id, legacy.requester_player_id,
       legacy.owner_player_id, legacy.status, legacy.create_request_id,
       legacy.resolution_request_id, legacy.created_at, legacy.updated_at,
       legacy.expires_at, legacy.resolved_at
FROM flag_passage_requests legacy
JOIN custom_flag_group_memberships membership ON membership.flag_id = legacy.flag_id
ON CONFLICT (id) DO NOTHING;

ALTER TABLE flag_travel_commands DROP CONSTRAINT IF EXISTS flag_travel_commands_access_mode_check;
ALTER TABLE flag_travel_commands
  ADD COLUMN access_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN custom_group_id uuid NULL REFERENCES custom_flag_access_groups(id) ON DELETE SET NULL;
ALTER TABLE flag_travel_commands ADD CONSTRAINT flag_travel_commands_access_mode_check
  CHECK (access_mode IN ('private', 'public', 'normal', 'custom'));

CREATE OR REPLACE FUNCTION enforce_custom_group_membership_scope() RETURNS trigger AS $$
DECLARE flag_owner text; flag_control text; flag_mode text; group_owner text;
BEGIN
  SELECT owner_id, control_type, access_mode INTO flag_owner, flag_control, flag_mode
  FROM flags WHERE id = NEW.flag_id FOR UPDATE;
  SELECT owner_player_id INTO group_owner FROM custom_flag_access_groups WHERE id = NEW.group_id;
  IF flag_owner IS NULL OR group_owner IS NULL THEN
    RAISE EXCEPTION 'flag or Custom group does not exist' USING ERRCODE = '23503';
  END IF;
  IF flag_control <> 'personal' OR flag_mode <> 'custom' OR flag_owner <> group_owner THEN
    RAISE EXCEPTION 'Custom group membership requires a Custom flag with the same owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER custom_flag_group_membership_scope_guard
BEFORE INSERT OR UPDATE ON custom_flag_group_memberships
FOR EACH ROW EXECUTE FUNCTION enforce_custom_group_membership_scope();

CREATE OR REPLACE FUNCTION enforce_custom_group_override_scope() RETURNS trigger AS $$
DECLARE group_owner text;
BEGIN
  SELECT owner_player_id INTO group_owner FROM custom_flag_access_groups WHERE id = NEW.group_id;
  IF group_owner IS NULL THEN RAISE EXCEPTION 'Custom group does not exist' USING ERRCODE = '23503'; END IF;
  IF NEW.player_id = group_owner OR NEW.created_by_player_id <> group_owner THEN
    RAISE EXCEPTION 'invalid Custom group override authority' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER custom_flag_group_override_scope_guard
BEFORE INSERT OR UPDATE ON custom_flag_group_overrides
FOR EACH ROW EXECUTE FUNCTION enforce_custom_group_override_scope();

CREATE OR REPLACE FUNCTION enforce_player_flag_preference_scope() RETURNS trigger AS $$
DECLARE group_owner text;
BEGIN
  IF NEW.default_custom_group_id IS NOT NULL THEN
    SELECT owner_player_id INTO group_owner FROM custom_flag_access_groups
    WHERE id = NEW.default_custom_group_id;
    IF group_owner IS DISTINCT FROM NEW.owner_player_id THEN
      RAISE EXCEPTION 'default Custom group must belong to the preference owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER player_flag_preference_scope_guard
BEFORE INSERT OR UPDATE ON player_flag_preferences
FOR EACH ROW EXECUTE FUNCTION enforce_player_flag_preference_scope();

CREATE OR REPLACE FUNCTION enforce_normal_passage_grant_scope() RETURNS trigger AS $$
DECLARE low_id text; high_id text;
BEGIN
  low_id := LEAST(NEW.owner_player_id, NEW.grantee_player_id);
  high_id := GREATEST(NEW.owner_player_id, NEW.grantee_player_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('flag-access-pair:' || low_id || ':' || high_id, 0));
  IF EXISTS (SELECT 1 FROM player_enemy_marks
             WHERE (owner_id = low_id AND target_id = high_id)
                OR (owner_id = high_id AND target_id = low_id)) THEN
    RAISE EXCEPTION 'enemy Normal passage is forbidden' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM flags WHERE owner_id = NEW.owner_player_id
                 AND control_type = 'personal' AND access_mode = 'normal') THEN
    RAISE EXCEPTION 'Normal passage requires an owned Normal flag' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER normal_flag_passage_grant_scope_guard
BEFORE INSERT OR UPDATE ON normal_flag_passage_grants
FOR EACH ROW EXECUTE FUNCTION enforce_normal_passage_grant_scope();

CREATE OR REPLACE FUNCTION enforce_normal_passage_request_scope() RETURNS trigger AS $$
DECLARE flag_owner text; flag_mode text; low_id text; high_id text;
BEGIN
  low_id := LEAST(NEW.owner_player_id, NEW.requester_player_id);
  high_id := GREATEST(NEW.owner_player_id, NEW.requester_player_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('flag-access-pair:' || low_id || ':' || high_id, 0));
  SELECT owner_id, access_mode INTO flag_owner, flag_mode FROM flags WHERE id = NEW.source_flag_id FOR SHARE;
  IF flag_owner IS DISTINCT FROM NEW.owner_player_id OR flag_mode <> 'normal' THEN
    RAISE EXCEPTION 'Normal request source must be an owned Normal flag' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM player_enemy_marks
             WHERE (owner_id = low_id AND target_id = high_id)
                OR (owner_id = high_id AND target_id = low_id)) THEN
    RAISE EXCEPTION 'enemy Normal requests are forbidden' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER normal_flag_passage_request_scope_guard
BEFORE INSERT ON normal_flag_passage_requests
FOR EACH ROW EXECUTE FUNCTION enforce_normal_passage_request_scope();

CREATE OR REPLACE FUNCTION enforce_custom_passage_request_scope() RETURNS trigger AS $$
DECLARE group_owner text; accepting boolean; source_group uuid; low_id text; high_id text;
BEGIN
  low_id := LEAST(NEW.owner_player_id, NEW.requester_player_id);
  high_id := GREATEST(NEW.owner_player_id, NEW.requester_player_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('flag-access-pair:' || low_id || ':' || high_id, 0));
  SELECT owner_player_id, requests_enabled INTO group_owner, accepting
  FROM custom_flag_access_groups WHERE id = NEW.group_id FOR SHARE;
  SELECT group_id INTO source_group FROM custom_flag_group_memberships WHERE flag_id = NEW.source_flag_id;
  IF group_owner IS DISTINCT FROM NEW.owner_player_id OR source_group IS DISTINCT FROM NEW.group_id OR NOT accepting THEN
    RAISE EXCEPTION 'Custom request scope is unavailable' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM player_enemy_marks
             WHERE (owner_id = low_id AND target_id = high_id)
                OR (owner_id = high_id AND target_id = low_id)) THEN
    RAISE EXCEPTION 'enemy Custom requests are forbidden' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER custom_flag_group_request_scope_guard
BEFORE INSERT ON custom_flag_group_requests
FOR EACH ROW EXECUTE FUNCTION enforce_custom_passage_request_scope();

CREATE OR REPLACE FUNCTION prepare_personal_flag_access_change() RETURNS trigger AS $$
BEGIN
  IF OLD.control_type IS DISTINCT FROM NEW.control_type
     OR (OLD.owner_id IS DISTINCT FROM NEW.owner_id AND OLD.access_mode = 'custom') THEN
    NEW.access_mode := 'private';
    NEW.jump_toll_gold := 0;
    NEW.custom_requests_enabled := false;
  END IF;
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     OR OLD.control_type IS DISTINCT FROM NEW.control_type
     OR OLD.access_mode IS DISTINCT FROM NEW.access_mode
     OR OLD.jump_toll_gold IS DISTINCT FROM NEW.jump_toll_gold THEN
    NEW.access_revision := OLD.access_revision + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS flags_reset_access_before_control_change ON flags;
CREATE TRIGGER flags_prepare_access_before_change
BEFORE UPDATE OF owner_id, control_type, access_mode, jump_toll_gold ON flags
FOR EACH ROW EXECUTE FUNCTION prepare_personal_flag_access_change();

CREATE OR REPLACE FUNCTION invalidate_personal_flag_access_lifecycle() RETURNS trigger AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     OR OLD.control_type IS DISTINCT FROM NEW.control_type
     OR (OLD.access_mode = 'custom' AND NEW.access_mode <> 'custom') THEN
    DELETE FROM custom_flag_group_memberships WHERE flag_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS flags_invalidate_access_after_control_change ON flags;
CREATE TRIGGER flags_invalidate_access_after_control_change
AFTER UPDATE OF owner_id, control_type, access_mode ON flags
FOR EACH ROW EXECUTE FUNCTION invalidate_personal_flag_access_lifecycle();

CREATE OR REPLACE FUNCTION bump_custom_group_member_revisions() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE flags SET access_revision = access_revision + 1 WHERE id = OLD.flag_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE flags SET access_revision = access_revision + 1 WHERE id = NEW.flag_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER custom_flag_group_membership_revision
AFTER INSERT OR UPDATE OR DELETE ON custom_flag_group_memberships
FOR EACH ROW EXECUTE FUNCTION bump_custom_group_member_revisions();

CREATE OR REPLACE FUNCTION delete_disposable_empty_custom_group() RETURNS trigger AS $$
DECLARE departed_group uuid;
BEGIN
  departed_group := OLD.group_id;
  IF TG_OP = 'UPDATE' AND OLD.group_id IS NOT DISTINCT FROM NEW.group_id THEN
    RETURN NEW;
  END IF;
  DELETE FROM custom_flag_access_groups custom_group
  WHERE custom_group.id = departed_group
    AND NOT EXISTS (SELECT 1 FROM custom_flag_group_memberships membership WHERE membership.group_id = departed_group)
    AND NOT EXISTS (SELECT 1 FROM custom_flag_group_overrides override_row WHERE override_row.group_id = departed_group)
    AND NOT EXISTS (SELECT 1 FROM custom_flag_group_requests request_row WHERE request_row.group_id = departed_group)
    AND NOT EXISTS (SELECT 1 FROM player_flag_preferences preference WHERE preference.default_custom_group_id = departed_group);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER custom_flag_group_cleanup_after_membership
AFTER UPDATE OR DELETE ON custom_flag_group_memberships
FOR EACH ROW EXECUTE FUNCTION delete_disposable_empty_custom_group();

CREATE OR REPLACE FUNCTION bump_custom_group_access_revisions() RETURNS trigger AS $$
DECLARE affected_group uuid;
BEGIN
  affected_group := COALESCE(NEW.group_id, OLD.group_id);
  UPDATE flags f SET access_revision = f.access_revision + 1
  FROM custom_flag_group_memberships membership
  WHERE membership.group_id = affected_group AND f.id = membership.flag_id;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER custom_flag_group_override_revision
AFTER INSERT OR UPDATE OR DELETE ON custom_flag_group_overrides
FOR EACH ROW EXECUTE FUNCTION bump_custom_group_access_revisions();

CREATE OR REPLACE FUNCTION bump_normal_owner_flag_revisions() RETURNS trigger AS $$
DECLARE passage_owner text;
BEGIN
  passage_owner := COALESCE(NEW.owner_player_id, OLD.owner_player_id);
  UPDATE flags SET access_revision = access_revision + 1
  WHERE owner_id = passage_owner AND control_type = 'personal' AND access_mode = 'normal';
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER normal_flag_passage_grant_revision
AFTER INSERT OR UPDATE OR DELETE ON normal_flag_passage_grants
FOR EACH ROW EXECUTE FUNCTION bump_normal_owner_flag_revisions();

CREATE OR REPLACE FUNCTION revoke_normal_passage_for_enemies() RETURNS trigger AS $$
DECLARE low_id text; high_id text;
BEGIN
  low_id := LEAST(COALESCE(NEW.owner_id, OLD.owner_id), COALESCE(NEW.target_id, OLD.target_id));
  high_id := GREATEST(COALESCE(NEW.owner_id, OLD.owner_id), COALESCE(NEW.target_id, OLD.target_id));
  PERFORM pg_advisory_xact_lock(hashtextextended('flag-access-pair:' || low_id || ':' || high_id, 0));
  IF TG_OP = 'INSERT' THEN
    DELETE FROM normal_flag_passage_grants
    WHERE (owner_player_id = low_id AND grantee_player_id = high_id)
       OR (owner_player_id = high_id AND grantee_player_id = low_id);
    UPDATE normal_flag_passage_requests
    SET status = 'invalidated', resolved_at = now()
    WHERE status = 'pending' AND (
      (owner_player_id = low_id AND requester_player_id = high_id)
      OR (owner_player_id = high_id AND requester_player_id = low_id)
    );
  END IF;
  UPDATE flags SET access_revision = access_revision + 1
  WHERE owner_id IN (low_id, high_id) AND control_type = 'personal';
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER player_enemy_marks_flag_access_lifecycle
AFTER INSERT OR DELETE ON player_enemy_marks
FOR EACH ROW EXECUTE FUNCTION revoke_normal_passage_for_enemies();

COMMENT ON COLUMN flags.jump_toll_gold IS
  'Authoritative whole-gold jump toll for Public or Normal personal flags.';
COMMENT ON COLUMN flags.access_revision IS
  'Monotonic personal-flag access revision used to reject stale travel commands.';
COMMENT ON TABLE normal_flag_passage_grants IS
  'Directional owner-wide passage to every current and future Normal flag.';
COMMENT ON TABLE custom_flag_access_groups IS
  'Owner-scoped shared Custom flag access policies.';
COMMENT ON TABLE flag_access_overrides IS
  'Legacy 0658 per-flag overrides retained for migration audit; runtime authority moved to Custom groups.';
COMMENT ON TABLE flag_passage_requests IS
  'Legacy 0658 per-flag requests retained for migration audit; runtime authority moved to scoped request tables.';
