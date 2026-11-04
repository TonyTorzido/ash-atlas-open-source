-- Converting one legal personal flag to Kingdom control does not change its
-- geometry, so it must not invalidate other legal, overlapping personal flags.
-- Keep the deferred constraint trigger in place because flag mutations defer it
-- by name, but retire the obsolete mixed-control overlap rejection.
CREATE OR REPLACE FUNCTION enforce_mixed_flag_control_geometry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END;
$$;
