ALTER TABLE chat_channels
  ADD COLUMN IF NOT EXISTS deletion_revision BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  ALTER TABLE chat_channels
    ADD CONSTRAINT chat_channels_deletion_revision_valid CHECK (deletion_revision >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
