ALTER TABLE combat_reward_settlements
  ADD COLUMN IF NOT EXISTS candidate jsonb NULL,
  ADD COLUMN IF NOT EXISTS prepared_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0
    CHECK (failure_count >= 0),
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS worker_id text NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz NULL;

UPDATE combat_reward_settlements AS settlement
SET prepared_at = COALESCE(settlement.completed_at, settlement.updated_at)
WHERE settlement.prepared_at IS NULL
  AND settlement.candidate IS NULL
  AND (
    settlement.status = 'completed'
    OR EXISTS (
      SELECT 1 FROM combat_reward_participants AS participant
      WHERE participant.settlement_key = settlement.settlement_key
    )
  );

CREATE INDEX IF NOT EXISTS combat_reward_inbox_claim_idx
  ON combat_reward_settlements (next_retry_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS combat_reward_inbox_expired_lease_idx
  ON combat_reward_settlements (lease_expires_at)
  WHERE status = 'processing';

COMMENT ON COLUMN combat_reward_settlements.candidate IS
  'Application-immutable authoritative candidate accepted before reward-bearing defeat finalization.';
