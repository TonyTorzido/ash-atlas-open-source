-- Token-unlocked dungeon skills (Stonefinder, Beastlore, Hermit's Gift): one row per unlocked skill.
CREATE TABLE player_dungeon_skills (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  skill_id text NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 80),
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, skill_id)
);
