-- Remove unattached helpers from the retired Custom flag-access schema.
DROP FUNCTION IF EXISTS reset_personal_flag_access_lifecycle();
DROP FUNCTION IF EXISTS enforce_flag_access_override_scope();
