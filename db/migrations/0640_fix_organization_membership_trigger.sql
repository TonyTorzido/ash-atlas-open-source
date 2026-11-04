CREATE OR REPLACE FUNCTION enforce_organization_membership_exclusivity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'city_memberships' THEN
    IF NEW.left_at IS NULL
       AND EXISTS (
         SELECT 1 FROM kingdom_memberships
         WHERE player_id = NEW.player_id AND status = 'active'
       ) THEN
      RAISE EXCEPTION 'Player already has an active Kingdom membership'
        USING ERRCODE = '23514', CONSTRAINT = 'organization_membership_exclusive';
    END IF;
  ELSIF TG_TABLE_NAME = 'kingdom_memberships' THEN
    IF NEW.status = 'active'
       AND EXISTS (
         SELECT 1 FROM city_memberships
         WHERE player_id = NEW.player_id AND left_at IS NULL
       ) THEN
      RAISE EXCEPTION 'Player already has an active City membership'
        USING ERRCODE = '23514', CONSTRAINT = 'organization_membership_exclusive';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
