CREATE TABLE player_announcement_dismissals (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  announcement_id uuid NOT NULL REFERENCES player_announcements(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, announcement_id)
);
