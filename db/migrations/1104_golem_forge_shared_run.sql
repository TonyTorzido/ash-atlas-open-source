-- Golem Forge batch 2a (docs/design/GOLEM_FORGE_PLAN.md sections 2-3): one shared run per Forge.
--
-- dungeon_run_admissions: a paid entry into a shared run. The torch lobby charges each member in one
-- transaction and writes one row per member (party_entry_id groups that start; party_torch_total is
-- the party's torches, which decides its extra mob sets). Entering consumes the player's newest
-- unentered admission (entered_at). A re-entry needs a new admission, so it pays again.
--
-- dungeon_instance_state.party_entries: per run, each party entry's torches and the rooms its extra
-- sets already spawned in, plus which entry each player came in with.
-- dungeon_instance_state.boss_credits: per boss encounter, the players inside when its fight started.
CREATE TABLE IF NOT EXISTS dungeon_run_admissions (
  admission_id uuid PRIMARY KEY,
  party_entry_id uuid NOT NULL,
  instance_id text NOT NULL,
  run_id uuid NOT NULL,
  dungeon_id text NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  torches integer NOT NULL,
  party_torch_total integer NOT NULL,
  bosses_alive integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  entered_at timestamptz,
  FOREIGN KEY (instance_id, run_id) REFERENCES dungeon_instance_runs(instance_id, run_id) ON DELETE RESTRICT,
  CONSTRAINT dungeon_run_admissions_identity_valid CHECK (length(instance_id) > 0 AND length(dungeon_id) > 0),
  CONSTRAINT dungeon_run_admissions_torches_valid CHECK (
    torches >= 0 AND torches <= 10 AND party_torch_total >= 1 AND party_torch_total <= 10
    AND torches <= party_torch_total
  ),
  CONSTRAINT dungeon_run_admissions_bosses_valid CHECK (bosses_alive >= 0)
);

CREATE INDEX IF NOT EXISTS dungeon_run_admissions_unentered_idx
  ON dungeon_run_admissions (instance_id, run_id, player_id, created_at DESC)
  WHERE entered_at IS NULL;

ALTER TABLE dungeon_instance_state
  ADD COLUMN IF NOT EXISTS party_entries jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS boss_credits jsonb NOT NULL DEFAULT '{}'::jsonb;
