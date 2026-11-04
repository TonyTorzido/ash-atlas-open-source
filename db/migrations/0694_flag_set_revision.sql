CREATE TABLE IF NOT EXISTS flag_set_revision (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO flag_set_revision (singleton, revision)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION advance_flag_set_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE flag_set_revision
  SET revision = revision + 1,
      updated_at = clock_timestamp()
  WHERE singleton;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS flags_advance_set_revision ON flags;
CREATE TRIGGER flags_advance_set_revision
AFTER INSERT OR UPDATE OR DELETE ON flags
FOR EACH STATEMENT
EXECUTE FUNCTION advance_flag_set_revision();

DROP TRIGGER IF EXISTS players_advance_flag_set_revision ON players;
CREATE TRIGGER players_advance_flag_set_revision
AFTER UPDATE OF username, personal_flag_color ON players
FOR EACH STATEMENT
EXECUTE FUNCTION advance_flag_set_revision();

DROP TRIGGER IF EXISTS kingdoms_advance_flag_set_revision ON kingdoms;
CREATE TRIGGER kingdoms_advance_flag_set_revision
AFTER INSERT OR UPDATE OR DELETE ON kingdoms
FOR EACH STATEMENT
EXECUTE FUNCTION advance_flag_set_revision();

DROP TRIGGER IF EXISTS kingdom_seats_advance_flag_set_revision ON kingdom_seats;
CREATE TRIGGER kingdom_seats_advance_flag_set_revision
AFTER INSERT OR UPDATE OR DELETE ON kingdom_seats
FOR EACH STATEMENT
EXECUTE FUNCTION advance_flag_set_revision();
