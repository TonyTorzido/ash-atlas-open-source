-- Creature Book archetype membership moves from hard-coded CHECK lists to the
-- server. Every Creature Book write is gated by isCreatureBookArchetype(), which
-- reads the shared CREATURE_BOOK_ROSTER, so adding a creature no longer needs a
-- migration. The database keeps a key-format check only.
--
-- Existing rows already satisfy the old lists, which are a subset of the new
-- format, so no data changes.

ALTER TABLE creature_book_sightings
  DROP CONSTRAINT IF EXISTS creature_book_sightings_mob_archetype_check;
ALTER TABLE creature_book_kill_occurrences
  DROP CONSTRAINT IF EXISTS creature_book_kill_occurrences_mob_archetype_check;
ALTER TABLE creature_book_ashen_sightings
  DROP CONSTRAINT IF EXISTS creature_book_ashen_sightings_mob_archetype_check;

ALTER TABLE creature_book_sightings
  ADD CONSTRAINT creature_book_sightings_mob_archetype_format
  CHECK (mob_archetype ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE creature_book_kill_occurrences
  ADD CONSTRAINT creature_book_kill_occurrences_mob_archetype_format
  CHECK (mob_archetype ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE creature_book_ashen_sightings
  ADD CONSTRAINT creature_book_ashen_sightings_mob_archetype_format
  CHECK (mob_archetype ~ '^[a-z][a-z0-9_]{0,63}$');
