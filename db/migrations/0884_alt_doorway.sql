BEGIN;

-- Alt doorway protections (docs/architecture/ACCOUNT_TRUST_AND_ANTISPOOF_PLAN.md,
-- "Alt doorway protections"). Moving yourself is free; bringing others is earned.
-- home_*: set from the first accepted fix; a passive-derived home is replaced
-- once by the first accepted GPS relocation (home_source).
-- confirmed_days: UTC days with a passive fix within TRUST_PRESENCE_RADIUS_KM of home.
-- home_confirmed_at: set when confirmed_days reaches TRUST_DOORWAY_CONFIRMED_DAYS
-- (or by the grandfathering below).
-- arrival_raid_hold_until: flag burn/attack wait after arriving by travel invite or party travel.
ALTER TABLE account_location_state
  ADD COLUMN IF NOT EXISTS home_lat double precision NULL CHECK (home_lat IS NULL OR home_lat BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS home_lon double precision NULL CHECK (home_lon IS NULL OR home_lon BETWEEN -180 AND 180),
  ADD COLUMN IF NOT EXISTS home_set_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS home_source text NULL CHECK (home_source IS NULL OR home_source IN ('passive', 'relocation')),
  ADD COLUMN IF NOT EXISTS confirmed_days integer NOT NULL DEFAULT 0 CHECK (confirmed_days >= 0),
  ADD COLUMN IF NOT EXISTS last_confirmed_day date NULL,
  ADD COLUMN IF NOT EXISTS home_confirmed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS arrival_raid_hold_until timestamptz NULL;

-- Grandfather veterans: accounts older than 14 days are doorway-confirmed now.
INSERT INTO account_location_state (account_id, home_confirmed_at)
SELECT a.id, now()
  FROM accounts a
 WHERE a.created_at < now() - interval '14 days'
   AND a.status <> 'deleted'
ON CONFLICT (account_id) DO UPDATE
  SET home_confirmed_at = EXCLUDED.home_confirmed_at,
      updated_at = now()
  WHERE account_location_state.home_confirmed_at IS NULL;

COMMIT;
