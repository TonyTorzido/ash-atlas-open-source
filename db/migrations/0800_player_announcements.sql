CREATE TABLE player_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key uuid NOT NULL UNIQUE,
  title text NOT NULL,
  message text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT player_announcements_title_length_check
    CHECK (char_length(title) BETWEEN 1 AND 80 AND title = btrim(title)),
  CONSTRAINT player_announcements_message_length_check
    CHECK (char_length(message) BETWEEN 1 AND 2000 AND message = btrim(message))
);

CREATE INDEX player_announcements_newest_idx
  ON player_announcements (published_at DESC, id DESC);
