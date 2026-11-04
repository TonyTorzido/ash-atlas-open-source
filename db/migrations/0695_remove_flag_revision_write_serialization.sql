CREATE SEQUENCE IF NOT EXISTS flag_set_revision_sequence AS bigint;
ALTER SEQUENCE flag_set_revision_sequence
OWNED BY flag_set_revision.revision;

DO $$
DECLARE
  current_revision bigint;
BEGIN
  SELECT revision
  INTO current_revision
  FROM flag_set_revision
  WHERE singleton;

  IF COALESCE(current_revision, 0) > 0 THEN
    PERFORM setval(
      'flag_set_revision_sequence',
      current_revision,
      true
    );
  ELSE
    PERFORM setval('flag_set_revision_sequence', 1, false);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION advance_flag_set_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ash-atlas-flag-snapshot-v1', 0)
  );
  PERFORM nextval('flag_set_revision_sequence');
  RETURN NULL;
END
$$;
