-- One row per dungeon run: timing, torches, party and deaths, collected now so clear-time grading
-- can be tuned later from real data (dungeon procgen plan, owner decision 6). Nothing grades yet.
--
-- The first entry of a run inserts the row (started_at); every entrant adds itself to
-- deaths_by_player with 0 and party_size counts them. complete_dungeon ends it as 'cleared'.
-- A run that ends without a clear (the instance empties and its run rotates) ends as 'wiped'
-- when every entrant died at least once, otherwise 'abandoned'.
--
-- Per-player deaths are a jsonb object {player_id: deaths} rather than a child table: the row is
-- write-once analytics read as a whole, at most 5 keys, and never joined or constrained per player.
CREATE TABLE IF NOT EXISTS dungeon_run_stats (
  run_id uuid PRIMARY KEY,
  instance_id text NOT NULL,
  dungeon_id text NOT NULL,
  tier text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_ms bigint,
  torch_total integer NOT NULL,
  party_size integer NOT NULL DEFAULT 0,
  result text,
  deaths_by_player jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT dungeon_run_stats_identity_valid CHECK (length(instance_id) > 0 AND length(dungeon_id) > 0),
  CONSTRAINT dungeon_run_stats_tier_valid CHECK (tier IS NULL OR tier ~ '^t[0-9]{2}$'),
  CONSTRAINT dungeon_run_stats_counts_valid CHECK (torch_total >= 0 AND party_size >= 0),
  CONSTRAINT dungeon_run_stats_result_valid CHECK (result IS NULL OR result IN ('cleared', 'abandoned', 'wiped')),
  CONSTRAINT dungeon_run_stats_end_consistent CHECK (
    (ended_at IS NULL) = (result IS NULL) AND (ended_at IS NULL) = (duration_ms IS NULL)
    AND (duration_ms IS NULL OR duration_ms >= 0)
  ),
  CONSTRAINT dungeon_run_stats_deaths_object CHECK (jsonb_typeof(deaths_by_player) = 'object')
);

CREATE INDEX IF NOT EXISTS dungeon_run_stats_dungeon_started_idx
  ON dungeon_run_stats (dungeon_id, started_at DESC);
