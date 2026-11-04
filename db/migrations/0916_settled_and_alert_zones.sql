BEGIN;

-- Settled status, alert inbox and arrival graph
-- (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md §2, §3.6, §4.4, §7).
-- account_settlement is the only home read by Settled, doorway and anchoring
-- code. Targets are secret: server-only, never sent to clients.
-- counted_days counts distinct UTC days (last_counted_day guards repeats).
-- distinct_positions counts changes of the 4-dp position key among counted
-- fixes (last_position_key), capped at 10.
CREATE TABLE IF NOT EXISTS account_settlement (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  home_lat double precision NULL CHECK (home_lat IS NULL OR home_lat BETWEEN -90 AND 90),
  home_lon double precision NULL CHECK (home_lon IS NULL OR home_lon BETWEEN -180 AND 180),
  home_set_at timestamptz NULL,
  settled_home_lat double precision NULL CHECK (settled_home_lat IS NULL OR settled_home_lat BETWEEN -90 AND 90),
  settled_home_lon double precision NULL CHECK (settled_home_lon IS NULL OR settled_home_lon BETWEEN -180 AND 180),
  settled_home_at timestamptz NULL,
  target_checks integer NOT NULL CHECK (target_checks BETWEEN 1 AND 500),
  target_days integer NOT NULL CHECK (target_days BETWEEN 1 AND 60),
  difficulty numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (difficulty BETWEEN 1 AND 5),
  counted_checks integer NOT NULL DEFAULT 0 CHECK (counted_checks >= 0),
  counted_days integer NOT NULL DEFAULT 0 CHECK (counted_days >= 0),
  last_counted_day date NULL,
  last_counted_at timestamptz NULL,
  distinct_positions integer NOT NULL DEFAULT 0 CHECK (distinct_positions BETWEEN 0 AND 10),
  last_position_key text NULL CHECK (last_position_key IS NULL OR char_length(last_position_key) <= 32),
  settled_at timestamptz NULL,
  provisional_until timestamptz NULL,
  unsettled_at timestamptz NULL,
  unsettle_reason text NULL CHECK (unsettle_reason IS NULL OR unsettle_reason IN
    ('location_mock','relocation_mock','attest_tamper','attest_app_fail','hard_mismatch','admin','moved_away','grandfather_expired')),
  free_repick_used_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((home_lat IS NULL) = (home_lon IS NULL)),
  CHECK ((settled_home_lat IS NULL) = (settled_home_lon IS NULL))
);
CREATE INDEX IF NOT EXISTS account_settlement_provisional_idx
  ON account_settlement (provisional_until) WHERE provisional_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS trust_alerts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('zone_red','zone_orange','zone_yellow','mismatch','settled_revoked','mass_arrival')),
  severity smallint NOT NULL CHECK (severity BETWEEN 1 AND 4),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','locked','dismissed')),
  cell_key text NULL CHECK (cell_key IS NULL OR char_length(cell_key) <= 32),
  lat_rounded double precision NULL,
  lon_rounded double precision NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 4096),
  allowance_expires_at timestamptz NULL,
  decided_by uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  decided_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trust_alerts_pending_idx
  ON trust_alerts (severity DESC, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS trust_alerts_account_idx
  ON trust_alerts (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_alerts_decided_by_idx
  ON trust_alerts (decided_by) WHERE decided_by IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trust_alerts_one_pending_red_idx
  ON trust_alerts (account_id) WHERE kind = 'zone_red' AND status = 'pending';

CREATE TABLE IF NOT EXISTS trust_arrivals (
  id uuid PRIMARY KEY,
  host_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  guest_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('invite','party_manual','party_auto_follow')),
  lat_rounded double precision NULL,
  lon_rounded double precision NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trust_arrivals_host_idx ON trust_arrivals (host_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_arrivals_guest_idx ON trust_arrivals (guest_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trust_arrivals_created_idx ON trust_arrivals (created_at);

-- Grandfather + seed (§2.5). One row per non-deleted account:
--   earned:  age >= 14 d, confirmed_days >= 3, no unreversed speed_impossible /
--            location_mock / relocation_mock signal, and a home => Settled.
--   blanket: age >= 14 d, home confirmed by the 0884 backfill (confirmed_days < 3),
--            same signal rule and a home => provisional Settled for 30 days
--            with halved targets (the runtime job revokes it if not earned).
--   others:  unsettled with fresh targets (22-30 checks, 4-6 days).
-- Home = 0884 home, else the last applied GPS relocation fix, else none.
WITH candidates AS (
  SELECT a.id AS account_id,
         a.created_at <= now() - interval '14 days' AS old_enough,
         COALESCE(s.confirmed_days, 0) AS confirmed_days,
         s.home_confirmed_at,
         COALESCE(s.home_lat, relocation.lat) AS home_lat,
         COALESCE(s.home_lon, relocation.lon) AS home_lon,
         CASE WHEN s.home_lat IS NOT NULL THEN s.home_set_at ELSE relocation.received_at END AS home_set_at,
         EXISTS (
           SELECT 1 FROM account_trust_events e
            WHERE e.account_id = a.id
              AND e.kind = 'signal'
              AND e.reversed_at IS NULL
              AND e.rule IN ('speed_impossible', 'location_mock', 'relocation_mock')
         ) AS flagged,
         22 + floor(random() * 9)::int AS rolled_checks,
         4 + floor(random() * 3)::int AS rolled_days
    FROM accounts a
    LEFT JOIN account_location_state s ON s.account_id = a.id
    LEFT JOIN LATERAL (
      SELECT r.lat, r.lon, r.received_at
        FROM location_reports r
       WHERE r.account_id = a.id
         AND r.source = 'relocation'
         AND r.verdict IN ('accepted', 'shadow_rejected')
       ORDER BY r.received_at DESC, r.id DESC
       LIMIT 1
    ) relocation ON true
   WHERE a.status <> 'deleted'
),
classified AS (
  SELECT c.*,
         CASE
           WHEN c.old_enough AND NOT c.flagged AND c.home_lat IS NOT NULL AND c.confirmed_days >= 3
             THEN 'earned'
           WHEN c.old_enough AND NOT c.flagged AND c.home_lat IS NOT NULL
                AND c.home_confirmed_at IS NOT NULL AND c.confirmed_days < 3
             THEN 'blanket'
           ELSE 'unsettled'
         END AS bucket
    FROM candidates c
)
INSERT INTO account_settlement (
  account_id, home_lat, home_lon, home_set_at,
  settled_home_lat, settled_home_lon, settled_home_at,
  target_checks, target_days, settled_at, provisional_until, updated_at
)
SELECT account_id, home_lat, home_lon, home_set_at,
       CASE WHEN bucket = 'unsettled' THEN NULL ELSE home_lat END,
       CASE WHEN bucket = 'unsettled' THEN NULL ELSE home_lon END,
       CASE WHEN bucket = 'unsettled' THEN NULL ELSE now() END,
       CASE WHEN bucket = 'blanket' THEN ceil(rolled_checks / 2.0)::int ELSE rolled_checks END,
       CASE WHEN bucket = 'blanket' THEN ceil(rolled_days / 2.0)::int ELSE rolled_days END,
       CASE WHEN bucket = 'unsettled' THEN NULL ELSE now() END,
       CASE WHEN bucket = 'blanket' THEN now() + interval '30 days' ELSE NULL END,
       now()
  FROM classified
ON CONFLICT (account_id) DO NOTHING;

COMMIT;
