-- Durable Google Cloud Translation cache and UTC-month source-character usage ledger.

CREATE TABLE IF NOT EXISTS chat_translation_cache (
  message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE RESTRICT,
  target_language text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  version text NOT NULL,
  translated_text text NOT NULL,
  source_language text NULL,
  source_characters integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, target_language, provider, model, version),
  CONSTRAINT chat_translation_cache_target_language_valid CHECK (
    target_language IN ('en', 'es', 'fr', 'de', 'pt', 'ja')
  ),
  CONSTRAINT chat_translation_cache_provider_valid CHECK (char_length(btrim(provider)) BETWEEN 1 AND 64),
  CONSTRAINT chat_translation_cache_model_valid CHECK (char_length(btrim(model)) BETWEEN 1 AND 32),
  CONSTRAINT chat_translation_cache_version_valid CHECK (char_length(btrim(version)) BETWEEN 1 AND 32),
  CONSTRAINT chat_translation_cache_text_valid CHECK (char_length(btrim(translated_text)) > 0),
  CONSTRAINT chat_translation_cache_source_language_valid CHECK (
    source_language IS NULL OR char_length(btrim(source_language)) BETWEEN 1 AND 32
  ),
  CONSTRAINT chat_translation_cache_source_characters_valid CHECK (
    source_characters BETWEEN 1 AND 400
  )
);

CREATE TABLE IF NOT EXISTS chat_translation_usage (
  usage_month date PRIMARY KEY,
  source_characters bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_translation_usage_month_valid CHECK (
    usage_month = date_trunc('month', usage_month)::date
  ),
  CONSTRAINT chat_translation_usage_source_characters_valid CHECK (
    source_characters >= 0
  )
);

CREATE INDEX IF NOT EXISTS chat_translation_cache_message_idx
  ON chat_translation_cache (message_id, target_language, created_at DESC);

DROP TRIGGER IF EXISTS chat_translation_usage_set_updated_at ON chat_translation_usage;
CREATE TRIGGER chat_translation_usage_set_updated_at
BEFORE UPDATE ON chat_translation_usage
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
