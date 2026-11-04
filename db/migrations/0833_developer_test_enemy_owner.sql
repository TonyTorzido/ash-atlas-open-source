-- Developer warfare fixtures retain the creator relation for durable cleanup
-- and replay ownership, but expose a dedicated hostile presentation owner so
-- they can never look like the creator's private/friendly fortifications.
ALTER TABLE developer_spawned_test_flags
  ADD COLUMN IF NOT EXISTS test_owner_id text NOT NULL DEFAULT 'developer-test-opponent',
  ADD COLUMN IF NOT EXISTS test_owner_name text NOT NULL DEFAULT 'Developer Test Enemy';

ALTER TABLE developer_spawned_test_flags
  DROP CONSTRAINT IF EXISTS developer_spawned_test_flags_test_owner_id_check,
  DROP CONSTRAINT IF EXISTS developer_spawned_test_flags_test_owner_name_check,
  ADD CONSTRAINT developer_spawned_test_flags_test_owner_id_check
    CHECK (length(test_owner_id) BETWEEN 1 AND 160),
  ADD CONSTRAINT developer_spawned_test_flags_test_owner_name_check
    CHECK (length(test_owner_name) BETWEEN 1 AND 160);

CREATE INDEX IF NOT EXISTS developer_spawned_test_flags_test_owner_idx
  ON developer_spawned_test_flags(test_owner_id, created_at, flag_id);
