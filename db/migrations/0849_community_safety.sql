CREATE TABLE IF NOT EXISTS player_terms_acceptances (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, terms_version),
  CONSTRAINT player_terms_acceptances_version_valid CHECK (
    char_length(btrim(terms_version)) BETWEEN 1 AND 64
  )
);

CREATE INDEX IF NOT EXISTS player_terms_acceptances_latest_idx
  ON player_terms_acceptances (player_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS ugc_reports (
  id uuid PRIMARY KEY,
  reporter_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  target_kind text NOT NULL,
  target_message_id uuid NULL REFERENCES chat_messages(id) ON DELETE RESTRICT,
  target_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  channel_id uuid NULL REFERENCES chat_channels(id) ON DELETE RESTRICT,
  category text NOT NULL,
  explanation text NULL,
  status text NOT NULL DEFAULT 'pending',
  reviewed_at timestamptz NULL,
  reviewed_by text NULL,
  resolution text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ugc_reports_target_kind_valid CHECK (target_kind IN ('message', 'player')),
  CONSTRAINT ugc_reports_target_shape_valid CHECK (
    (target_kind = 'message' AND target_message_id IS NOT NULL AND target_player_id IS NULL)
    OR (target_kind = 'player' AND target_message_id IS NULL AND target_player_id IS NOT NULL)
  ),
  CONSTRAINT ugc_reports_category_valid CHECK (
    category IN ('harassment', 'hate', 'sexual', 'threat', 'illegal', 'spam', 'cheating', 'other')
  ),
  CONSTRAINT ugc_reports_explanation_valid CHECK (
    explanation IS NULL OR char_length(btrim(explanation)) BETWEEN 1 AND 1_000
  ),
  CONSTRAINT ugc_reports_status_valid CHECK (
    status IN ('pending', 'reviewing', 'actioned', 'dismissed')
  ),
  CONSTRAINT ugc_reports_review_shape_valid CHECK (
    (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR status <> 'pending'
  )
);

CREATE INDEX IF NOT EXISTS ugc_reports_queue_idx
  ON ugc_reports (status, created_at ASC);

CREATE INDEX IF NOT EXISTS ugc_reports_reporter_idx
  ON ugc_reports (reporter_player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ugc_reports_message_idx
  ON ugc_reports (target_message_id)
  WHERE target_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ugc_reports_player_idx
  ON ugc_reports (target_player_id)
  WHERE target_player_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ugc_reports_open_message_unique_idx
  ON ugc_reports (reporter_player_id, target_message_id)
  WHERE target_message_id IS NOT NULL AND status IN ('pending', 'reviewing');

CREATE UNIQUE INDEX IF NOT EXISTS ugc_reports_open_player_unique_idx
  ON ugc_reports (reporter_player_id, target_player_id)
  WHERE target_player_id IS NOT NULL AND status IN ('pending', 'reviewing');

DROP TRIGGER IF EXISTS ugc_reports_set_updated_at ON ugc_reports;
CREATE TRIGGER ugc_reports_set_updated_at
BEFORE UPDATE ON ugc_reports
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
