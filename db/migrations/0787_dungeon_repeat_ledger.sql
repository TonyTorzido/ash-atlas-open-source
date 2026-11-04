-- Durable, idempotent dungeon completion snapshots and repeat-entry cooldowns.

CREATE TABLE dungeon_completion_ledger (
  completion_key text PRIMARY KEY CHECK (length(completion_key) BETWEEN 1 AND 200),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  dungeon_key text NOT NULL CHECK (length(dungeon_key) BETWEEN 1 AND 200),
  session_identity text NOT NULL CHECK (length(session_identity) BETWEEN 1 AND 200),
  delvers_lore_rank smallint NOT NULL CHECK (delvers_lore_rank BETWEEN 0 AND 3),
  cooldown_days smallint NOT NULL CHECK (cooldown_days BETWEEN 1 AND 365),
  completed_at timestamptz NOT NULL DEFAULT now(),
  lockout_expires_at timestamptz NOT NULL,
  UNIQUE (player_id, dungeon_key, session_identity),
  CHECK (lockout_expires_at > completed_at)
);

CREATE INDEX dungeon_completion_active_lockout_idx
  ON dungeon_completion_ledger (player_id, dungeon_key, lockout_expires_at DESC);
