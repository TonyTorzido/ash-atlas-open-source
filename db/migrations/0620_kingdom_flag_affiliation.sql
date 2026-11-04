ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS kingdom_id uuid NULL,
  ADD COLUMN IF NOT EXISTS kingdom_affiliated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS kingdom_affiliated_by_player_id text NULL;

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS current_kingdom_seat_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_kingdom_id_fkey'
  ) THEN
    ALTER TABLE flags
      ADD CONSTRAINT flags_kingdom_id_fkey
      FOREIGN KEY (kingdom_id) REFERENCES kingdoms(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass
      AND conname = 'flags_kingdom_affiliated_by_player_id_fkey'
  ) THEN
    ALTER TABLE flags
      ADD CONSTRAINT flags_kingdom_affiliated_by_player_id_fkey
      FOREIGN KEY (kingdom_affiliated_by_player_id) REFERENCES players(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'players'::regclass
      AND conname = 'players_current_kingdom_seat_id_fkey'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_current_kingdom_seat_id_fkey
      FOREIGN KEY (current_kingdom_seat_id) REFERENCES kingdom_seats(id) ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE players
  DROP CONSTRAINT IF EXISTS players_current_destination_exclusive,
  ADD CONSTRAINT players_current_destination_exclusive
    CHECK (current_flag_id IS NULL OR current_kingdom_seat_id IS NULL);

CREATE INDEX IF NOT EXISTS players_current_kingdom_seat_idx
  ON players (current_kingdom_seat_id)
  WHERE current_kingdom_seat_id IS NOT NULL;

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_city_kingdom_exclusive,
  ADD CONSTRAINT flags_city_kingdom_exclusive
    CHECK (city_id IS NULL OR kingdom_id IS NULL),
  DROP CONSTRAINT IF EXISTS flags_kingdom_affiliation_lifecycle_valid,
  ADD CONSTRAINT flags_kingdom_affiliation_lifecycle_valid CHECK (
    (kingdom_id IS NULL AND kingdom_affiliated_at IS NULL)
    OR
    (kingdom_id IS NOT NULL AND kingdom_affiliated_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS flags_kingdom_active_idx
  ON flags (kingdom_id, id)
  WHERE kingdom_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS flags_kingdom_owner_idx
  ON flags (owner_id, kingdom_id, id)
  WHERE kingdom_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS flags_kingdom_geom_gix
  ON flags USING gist ((geom::geography))
  WHERE kingdom_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_affiliated_flag_owner_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     AND OLD.kingdom_id IS NOT NULL
     AND NEW.kingdom_id IS NOT NULL THEN
    RAISE EXCEPTION 'Kingdom affiliation must be cleared before flag ownership changes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flags_prevent_affiliated_owner_transfer ON flags;
CREATE TRIGGER flags_prevent_affiliated_owner_transfer
BEFORE UPDATE OF owner_id ON flags
FOR EACH ROW EXECUTE FUNCTION prevent_affiliated_flag_owner_transfer();

CREATE TABLE IF NOT EXISTS kingdom_flag_affiliation_history (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  flag_id uuid NOT NULL,
  flag_owner_player_id text NOT NULL,
  performed_by_player_id text NULL,
  action text NOT NULL,
  reason text NOT NULL,
  request_id text NULL,
  prior_kingdom_id uuid NULL,
  resulting_kingdom_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_flag_affiliation_history_action_valid CHECK (
    action IN ('affiliated', 'removed', 'pruned', 'flag_deleted', 'kingdom_dissolved')
  ),
  CONSTRAINT kingdom_flag_affiliation_history_reason_nonempty
    CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS kingdom_flag_history_kingdom_created_idx
  ON kingdom_flag_affiliation_history (kingdom_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS kingdom_flag_history_flag_created_idx
  ON kingdom_flag_affiliation_history (flag_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS kingdom_flag_history_actor_request_idx
  ON kingdom_flag_affiliation_history (performed_by_player_id, request_id)
  WHERE request_id IS NOT NULL;
