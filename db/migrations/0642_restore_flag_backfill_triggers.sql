DROP TRIGGER IF EXISTS flags_kingdom_seat_source_identity ON flags;
CREATE CONSTRAINT TRIGGER flags_kingdom_seat_source_identity
AFTER INSERT OR UPDATE ON flags
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_source_flag_kingdom_seat_identity();

DROP TRIGGER IF EXISTS flags_mixed_control_geometry ON flags;
CREATE CONSTRAINT TRIGGER flags_mixed_control_geometry
AFTER INSERT OR UPDATE ON flags
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_mixed_flag_control_geometry();
