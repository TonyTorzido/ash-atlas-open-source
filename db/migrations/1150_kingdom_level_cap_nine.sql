-- Kingdom level cap 6 -> 9. Levels 7-9 exist but offer no perks
-- yet, so the per-level perk id list (kingdom_perk_selections_perk_valid) is
-- unchanged and still rejects any perk on levels 7-9.
--
-- Also fixes kingdom_xp_ledger_level_valid, which still capped level_after at
-- 5 (from 0400) and so made the 5 -> 6 advancement completion fail.

ALTER TABLE kingdoms DROP CONSTRAINT IF EXISTS kingdoms_level_valid;
ALTER TABLE kingdoms ADD CONSTRAINT kingdoms_level_valid CHECK (level BETWEEN 1 AND 9);

ALTER TABLE kingdom_projects DROP CONSTRAINT IF EXISTS kingdom_projects_target_level_valid;
ALTER TABLE kingdom_projects
  ADD CONSTRAINT kingdom_projects_target_level_valid CHECK (target_level BETWEEN 2 AND 9);

ALTER TABLE kingdom_perk_selections DROP CONSTRAINT IF EXISTS kingdom_perk_selections_level_valid;
ALTER TABLE kingdom_perk_selections
  ADD CONSTRAINT kingdom_perk_selections_level_valid CHECK (perk_level BETWEEN 2 AND 9);

-- 0929 declared this one inline, so Postgres named it <table>_<column>_check.
ALTER TABLE kingdom_perk_operations DROP CONSTRAINT IF EXISTS kingdom_perk_operations_perk_level_check;
ALTER TABLE kingdom_perk_operations DROP CONSTRAINT IF EXISTS kingdom_perk_operations_perk_level_valid;
ALTER TABLE kingdom_perk_operations
  ADD CONSTRAINT kingdom_perk_operations_perk_level_valid CHECK (perk_level BETWEEN 2 AND 9);

ALTER TABLE kingdom_xp_ledger DROP CONSTRAINT IF EXISTS kingdom_xp_ledger_level_valid;
ALTER TABLE kingdom_xp_ledger
  ADD CONSTRAINT kingdom_xp_ledger_level_valid CHECK (
    level_before BETWEEN 1 AND 9 AND level_after BETWEEN level_before AND 9
  );
