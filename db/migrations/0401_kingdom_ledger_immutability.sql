CREATE OR REPLACE FUNCTION prevent_kingdom_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS kingdom_donations_append_only ON kingdom_donations;
CREATE TRIGGER kingdom_donations_append_only
BEFORE UPDATE OR DELETE ON kingdom_donations
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

DROP TRIGGER IF EXISTS kingdom_xp_ledger_append_only ON kingdom_xp_ledger;
CREATE TRIGGER kingdom_xp_ledger_append_only
BEFORE UPDATE OR DELETE ON kingdom_xp_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

DROP TRIGGER IF EXISTS kingdom_audit_events_append_only ON kingdom_audit_events;
CREATE TRIGGER kingdom_audit_events_append_only
BEFORE UPDATE OR DELETE ON kingdom_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();
