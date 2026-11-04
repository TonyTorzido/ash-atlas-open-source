ALTER TABLE player_specialization_state
  ADD COLUMN IF NOT EXISTS committed_specialization_id text NULL;

UPDATE player_specialization_state AS state
SET committed_specialization_id = COALESCE(
  state.active_specialization_id,
  (
    SELECT MIN(ranks.specialization_id)
    FROM player_specialization_ranks AS ranks
    WHERE ranks.player_id = state.player_id
      AND ranks.rank > 0
    HAVING COUNT(*) = 1
  )
)
WHERE state.committed_specialization_id IS NULL;

DO $$ BEGIN
  ALTER TABLE player_specialization_state
    ADD CONSTRAINT player_specialization_state_committed_specialization_fk
    FOREIGN KEY (player_id, committed_specialization_id)
    REFERENCES player_specialization_ranks(player_id, specialization_id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE player_specialization_state
    ADD CONSTRAINT player_specialization_state_active_commitment_check
    CHECK (
      active_specialization_id IS NULL
      OR (
        committed_specialization_id IS NOT NULL
        AND active_specialization_id = committed_specialization_id
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN player_specialization_state.committed_specialization_id IS
  'Durable main-specialization commitment. Deactivation clears only active_specialization_id; respec must change commitment explicitly.';
