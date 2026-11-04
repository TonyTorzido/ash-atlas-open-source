BEGIN;

-- Owner decisions 2026-10-04 (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md §2.4, §4.3, §5).
-- 1. Settled review hold: a Settled account that tries to relocate into a red
--    zone has its Settled status paused (settled_at moved aside, reason
--    review_hold) until an admin approves the red alert, which restores it.
-- 2. New alert kinds: kingdom proximity, multi-accounting, account sharing and
--    state hopping.

ALTER TABLE account_settlement
  ADD COLUMN IF NOT EXISTS suspended_settled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS suspended_provisional_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS suspended_alert_id uuid NULL;

ALTER TABLE account_settlement DROP CONSTRAINT IF EXISTS account_settlement_unsettle_reason_check;
ALTER TABLE account_settlement ADD CONSTRAINT account_settlement_unsettle_reason_check CHECK (
  unsettle_reason IS NULL OR unsettle_reason IN (
    'location_mock', 'relocation_mock', 'attest_tamper', 'attest_app_fail', 'hard_mismatch', 'admin',
    'moved_away', 'grandfather_expired', 'review_hold'
  )
);

ALTER TABLE account_settlement DROP CONSTRAINT IF EXISTS account_settlement_review_hold_check;
ALTER TABLE account_settlement ADD CONSTRAINT account_settlement_review_hold_check CHECK (
  suspended_settled_at IS NULL OR (settled_at IS NULL AND unsettle_reason = 'review_hold')
);

ALTER TABLE trust_alerts DROP CONSTRAINT IF EXISTS trust_alerts_kind_check;
ALTER TABLE trust_alerts ADD CONSTRAINT trust_alerts_kind_check CHECK (
  kind IN (
    'zone_red', 'zone_orange', 'zone_yellow', 'mismatch', 'settled_revoked', 'mass_arrival',
    'kingdom_proximity', 'multi_account', 'account_shared', 'state_hopping'
  )
);

COMMIT;
