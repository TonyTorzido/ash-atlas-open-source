CREATE TABLE IF NOT EXISTS player_hotbar_settings (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  slots jsonb NOT NULL DEFAULT '[
    {"slotId":"left-1","binding":null},
    {"slotId":"left-2","binding":null},
    {"slotId":"left-3","binding":null},
    {"slotId":"right-1","binding":null},
    {"slotId":"right-2","binding":null},
    {"slotId":"right-3","binding":null}
  ]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS player_hotbar_settings_set_updated_at ON player_hotbar_settings;
CREATE TRIGGER player_hotbar_settings_set_updated_at
BEFORE UPDATE ON player_hotbar_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
