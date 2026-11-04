-- Personal-flag access control, passage requests, and idempotent public toll travel.
-- Existing personal flags were freely visitable before this migration, so they
-- are backfilled as public/free. New personal flags use the private defaults.

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS access_mode text,
  ADD COLUMN IF NOT EXISTS public_toll_gold bigint,
  ADD COLUMN IF NOT EXISTS custom_requests_enabled boolean;

UPDATE flags
SET access_mode = CASE WHEN control_type = 'personal' THEN 'public' ELSE 'private' END,
    public_toll_gold = 0,
    custom_requests_enabled = false
WHERE access_mode IS NULL
   OR public_toll_gold IS NULL
   OR custom_requests_enabled IS NULL;

-- Flush deferred flag-integrity triggers raised by the populated backfill
-- before changing the same table's column constraints.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE flags
  ALTER COLUMN access_mode SET DEFAULT 'private',
  ALTER COLUMN access_mode SET NOT NULL,
  ALTER COLUMN public_toll_gold SET DEFAULT 0,
  ALTER COLUMN public_toll_gold SET NOT NULL,
  ALTER COLUMN custom_requests_enabled SET DEFAULT false,
  ALTER COLUMN custom_requests_enabled SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_access_mode_check'
  ) THEN
    ALTER TABLE flags ADD CONSTRAINT flags_access_mode_check
      CHECK (access_mode IN ('private', 'public', 'custom'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_public_toll_gold_check'
  ) THEN
    ALTER TABLE flags ADD CONSTRAINT flags_public_toll_gold_check
      CHECK (public_toll_gold BETWEEN 0 AND 1000000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_access_scope_check'
  ) THEN
    ALTER TABLE flags ADD CONSTRAINT flags_access_scope_check CHECK (
      control_type = 'personal'
      OR (access_mode = 'private' AND public_toll_gold = 0 AND custom_requests_enabled = false)
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS flag_access_overrides (
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  access_type text NOT NULL CHECK (access_type IN ('allow', 'deny')),
  expires_at timestamptz NULL,
  created_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, player_id)
);

CREATE INDEX IF NOT EXISTS flag_access_overrides_flag_active_idx
  ON flag_access_overrides (flag_id, expires_at, player_id);

DROP TRIGGER IF EXISTS flag_access_overrides_set_updated_at ON flag_access_overrides;
CREATE TRIGGER flag_access_overrides_set_updated_at
BEFORE UPDATE ON flag_access_overrides
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION enforce_flag_access_override_scope() RETURNS trigger AS $$
DECLARE
  target_owner text;
  target_control text;
  target_mode text;
BEGIN
  SELECT owner_id, control_type, access_mode
  INTO target_owner, target_control, target_mode
  FROM flags WHERE id = NEW.flag_id;
  IF target_owner IS NULL THEN
    RAISE EXCEPTION 'flag does not exist' USING ERRCODE = '23503';
  END IF;
  IF NEW.player_id = target_owner THEN
    RAISE EXCEPTION 'flag owner cannot have an access override' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by_player_id <> target_owner THEN
    RAISE EXCEPTION 'only the current flag owner can create an override' USING ERRCODE = '23514';
  END IF;
  IF target_control <> 'personal' OR target_mode <> 'custom' THEN
    RAISE EXCEPTION 'access overrides require a custom personal flag' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS flag_access_overrides_scope_guard ON flag_access_overrides;
CREATE TRIGGER flag_access_overrides_scope_guard
BEFORE INSERT OR UPDATE ON flag_access_overrides
FOR EACH ROW EXECUTE FUNCTION enforce_flag_access_override_scope();

CREATE TABLE IF NOT EXISTS flag_passage_requests (
  id uuid PRIMARY KEY,
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
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
  CONSTRAINT flag_passage_requests_not_self_check CHECK (requester_player_id <> owner_player_id),
  CONSTRAINT flag_passage_requests_expiry_check CHECK (expires_at = created_at + interval '24 hours'),
  CONSTRAINT flag_passage_requests_requester_command_unique UNIQUE (requester_player_id, create_request_id),
  CONSTRAINT flag_passage_requests_resolution_shape_check CHECK (
    (status = 'pending' AND resolution_request_id IS NULL AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS flag_passage_requests_one_pending_idx
  ON flag_passage_requests (flag_id, requester_player_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS flag_passage_requests_owner_pending_idx
  ON flag_passage_requests (owner_player_id, flag_id, expires_at, id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS flag_passage_requests_owner_resolution_idx
  ON flag_passage_requests (owner_player_id, resolution_request_id)
  WHERE resolution_request_id IS NOT NULL;

DROP TRIGGER IF EXISTS flag_passage_requests_set_updated_at ON flag_passage_requests;
CREATE TRIGGER flag_passage_requests_set_updated_at
BEFORE UPDATE ON flag_passage_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS flag_travel_commands (
  traveler_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  access_mode text NOT NULL CHECK (access_mode IN ('private', 'public', 'custom')),
  toll_gold bigint NOT NULL CHECK (toll_gold BETWEEN 0 AND 1000000),
  completed_at timestamptz NULL,
  PRIMARY KEY (traveler_player_id, request_id)
);

CREATE INDEX IF NOT EXISTS flag_travel_commands_flag_created_idx
  ON flag_travel_commands (flag_id, completed_at DESC);

CREATE OR REPLACE FUNCTION reset_personal_flag_access_lifecycle() RETURNS trigger AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     OR OLD.control_type IS DISTINCT FROM NEW.control_type THEN
    NEW.access_mode := 'private';
    NEW.public_toll_gold := 0;
    NEW.custom_requests_enabled := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS flags_reset_access_before_control_change ON flags;
CREATE TRIGGER flags_reset_access_before_control_change
BEFORE UPDATE OF owner_id, control_type ON flags
FOR EACH ROW EXECUTE FUNCTION reset_personal_flag_access_lifecycle();

CREATE OR REPLACE FUNCTION invalidate_personal_flag_access_lifecycle() RETURNS trigger AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     OR OLD.control_type IS DISTINCT FROM NEW.control_type THEN
    DELETE FROM flag_access_overrides WHERE flag_id = NEW.id;
    UPDATE flag_passage_requests
    SET status = 'invalidated', resolved_at = now()
    WHERE flag_id = NEW.id AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS flags_invalidate_access_after_control_change ON flags;
CREATE TRIGGER flags_invalidate_access_after_control_change
AFTER UPDATE OF owner_id, control_type ON flags
FOR EACH ROW EXECUTE FUNCTION invalidate_personal_flag_access_lifecycle();

COMMENT ON COLUMN flags.access_mode IS
  'Server-owned travel access mode for ordinary personal flags only.';
COMMENT ON TABLE flag_access_overrides IS
  'Sparse per-flag Custom access decisions; expired rows have no authority.';
COMMENT ON TABLE flag_passage_requests IS
  'Durable, expiring Custom passage requests revalidated at resolution time.';
COMMENT ON TABLE flag_travel_commands IS
  'Completed personal-flag travel intents binding idempotency to flag, owner, mode, and toll.';
