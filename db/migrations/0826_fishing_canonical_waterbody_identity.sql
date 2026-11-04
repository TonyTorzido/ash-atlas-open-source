-- Repair the persisted fishing bindings created before canonical waterbody
-- identity became authoritative.  This is intentionally an exact, forward-
-- only data migration: source IDs are changed only for river rows carrying
-- the known legacy ID, and all other state remains untouched.

UPDATE fishing_hut_build_jobs
SET waterbody_source_id = '4bdb931c-d880-5cb0-b8b2-e9c8c220e83a'
WHERE waterbody_kind = 'river'
  AND waterbody_source_id = 'e2535b48a911bc1795c2f22cfaa290dc12978933964b815a609979d1d1321274';

UPDATE player_fishing_huts
SET waterbody_source_id = '4bdb931c-d880-5cb0-b8b2-e9c8c220e83a'
WHERE waterbody_kind = 'river'
  AND waterbody_source_id = 'e2535b48a911bc1795c2f22cfaa290dc12978933964b815a609979d1d1321274';

UPDATE fishing_encounters
SET waterbody_source_id = '4bdb931c-d880-5cb0-b8b2-e9c8c220e83a'
WHERE waterbody_kind = 'river'
  AND waterbody_source_id = 'e2535b48a911bc1795c2f22cfaa290dc12978933964b815a609979d1d1321274';

UPDATE fishing_catch_records
SET waterbody_source_id = '4bdb931c-d880-5cb0-b8b2-e9c8c220e83a'
WHERE waterbody_kind = 'river'
  AND waterbody_source_id = 'e2535b48a911bc1795c2f22cfaa290dc12978933964b815a609979d1d1321274';
