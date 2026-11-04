CREATE TABLE IF NOT EXISTS specialization_commitment_reconciliation_audit (
  audit_id bigserial PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  previous_committed_specialization_id text NULL,
  previous_active_specialization_id text NULL,
  resulting_committed_specialization_id text NULL,
  resulting_active_specialization_id text NULL,
  reason text NOT NULL CHECK (reason IN (
    'preserved_rank_three_commitment',
    'preferred_active_rank_three',
    'selected_highest_rank_three',
    'cleared_without_rank_three'
  )),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE player_specialization_state
  DROP CONSTRAINT IF EXISTS player_specialization_state_active_commitment_check;

CREATE TEMP TABLE specialization_commitment_reconciliation ON COMMIT DROP AS
SELECT state.player_id,
       state.committed_specialization_id AS previous_committed_specialization_id,
       state.active_specialization_id AS previous_active_specialization_id,
       CASE
         WHEN committed.rank >= 3 THEN state.committed_specialization_id
         WHEN active.rank >= 3 THEN state.active_specialization_id
         ELSE chosen.specialization_id
       END AS resulting_committed_specialization_id,
       CASE
         WHEN COALESCE(committed.rank, 0) >= 3 THEN 'preserved_rank_three_commitment'
         WHEN COALESCE(active.rank, 0) >= 3 THEN 'preferred_active_rank_three'
         WHEN chosen.specialization_id IS NOT NULL THEN 'selected_highest_rank_three'
         ELSE 'cleared_without_rank_three'
       END AS reason
FROM player_specialization_state AS state
LEFT JOIN player_specialization_ranks AS committed
  ON committed.player_id = state.player_id
 AND committed.specialization_id = state.committed_specialization_id
 AND committed.specialization_id IN ('warrior','ranger','ninja','paladin','cleric')
LEFT JOIN player_specialization_ranks AS active
  ON active.player_id = state.player_id
 AND active.specialization_id = state.active_specialization_id
 AND active.specialization_id IN ('warrior','ranger','ninja','paladin','cleric')
LEFT JOIN LATERAL (
  SELECT ranks.specialization_id
  FROM player_specialization_ranks AS ranks
  WHERE ranks.player_id = state.player_id
    AND ranks.rank >= 3
    AND ranks.specialization_id IN ('warrior','ranger','ninja','paladin','cleric')
  ORDER BY ranks.rank DESC, ranks.specialization_id ASC
  LIMIT 1
) AS chosen ON true;

INSERT INTO specialization_commitment_reconciliation_audit (
  player_id, previous_committed_specialization_id, previous_active_specialization_id,
  resulting_committed_specialization_id, resulting_active_specialization_id, reason
)
SELECT player_id, previous_committed_specialization_id, previous_active_specialization_id,
       resulting_committed_specialization_id,
       CASE
         WHEN resulting_committed_specialization_id IS NULL
           AND EXISTS (
             SELECT 1 FROM player_specialization_ranks AS ranks
             WHERE ranks.player_id = specialization_commitment_reconciliation.player_id
               AND ranks.specialization_id = previous_active_specialization_id
               AND ranks.rank > 0
               AND ranks.specialization_id IN ('warrior','ranger','ninja','paladin','cleric')
           ) THEN previous_active_specialization_id
         WHEN previous_active_specialization_id = resulting_committed_specialization_id
           THEN resulting_committed_specialization_id
         ELSE NULL
       END,
       reason
FROM specialization_commitment_reconciliation
WHERE previous_committed_specialization_id IS DISTINCT FROM resulting_committed_specialization_id
   OR previous_active_specialization_id IS DISTINCT FROM CASE
        WHEN resulting_committed_specialization_id IS NULL
          AND EXISTS (
            SELECT 1 FROM player_specialization_ranks AS ranks
            WHERE ranks.player_id = specialization_commitment_reconciliation.player_id
              AND ranks.specialization_id = previous_active_specialization_id
              AND ranks.rank > 0
              AND ranks.specialization_id IN ('warrior','ranger','ninja','paladin','cleric')
          ) THEN previous_active_specialization_id
        WHEN previous_active_specialization_id = resulting_committed_specialization_id
          THEN resulting_committed_specialization_id
        ELSE NULL
      END;

UPDATE player_specialization_state AS state
SET committed_specialization_id = reconciliation.resulting_committed_specialization_id,
    active_specialization_id = CASE
      WHEN reconciliation.resulting_committed_specialization_id IS NULL
        AND EXISTS (
          SELECT 1 FROM player_specialization_ranks AS ranks
          WHERE ranks.player_id = state.player_id
            AND ranks.specialization_id = state.active_specialization_id
            AND ranks.rank > 0
            AND ranks.specialization_id IN ('warrior','ranger','ninja','paladin','cleric')
        ) THEN state.active_specialization_id
      WHEN state.active_specialization_id = reconciliation.resulting_committed_specialization_id
        THEN reconciliation.resulting_committed_specialization_id
      ELSE NULL
    END,
    revision = state.revision + 1
FROM specialization_commitment_reconciliation AS reconciliation
WHERE reconciliation.player_id = state.player_id
  AND (
    state.committed_specialization_id IS DISTINCT FROM reconciliation.resulting_committed_specialization_id
    OR state.active_specialization_id IS DISTINCT FROM CASE
      WHEN reconciliation.resulting_committed_specialization_id IS NULL
        AND EXISTS (
          SELECT 1 FROM player_specialization_ranks AS ranks
          WHERE ranks.player_id = state.player_id
            AND ranks.specialization_id = state.active_specialization_id
            AND ranks.rank > 0
            AND ranks.specialization_id IN ('warrior','ranger','ninja','paladin','cleric')
        ) THEN state.active_specialization_id
      WHEN state.active_specialization_id = reconciliation.resulting_committed_specialization_id
        THEN reconciliation.resulting_committed_specialization_id
      ELSE NULL
    END
  );

ALTER TABLE player_specialization_state
  ADD CONSTRAINT player_specialization_state_active_commitment_check
  CHECK (
    active_specialization_id IS NULL
    OR committed_specialization_id IS NULL
    OR active_specialization_id = committed_specialization_id
  );

COMMENT ON TABLE specialization_commitment_reconciliation_audit IS
  'Immutable audit of the Rank-3 specialization commitment reconciliation introduced after migration 0778.';
COMMENT ON COLUMN player_specialization_state.committed_specialization_id IS
  'Durable launch-specialization commitment established atomically when Rank 3 is purchased.';
