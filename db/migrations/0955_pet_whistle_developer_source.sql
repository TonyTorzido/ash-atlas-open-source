-- Developer-granted whistles are marked so dev testing can call species whose skill gate or
-- source content has not shipped. Forward-only and idempotent.
ALTER TABLE account_pet_whistles DROP CONSTRAINT IF EXISTS account_pet_whistles_source_check;
ALTER TABLE account_pet_whistles ADD CONSTRAINT account_pet_whistles_source_check
  CHECK (source IN ('starter', 'migration', 'hatch', 'hermit', 'repair', 'developer'));
