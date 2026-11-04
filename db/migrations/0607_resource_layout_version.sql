ALTER TABLE flag_resource_visions
  ADD COLUMN IF NOT EXISTS layout_version text;

UPDATE flag_resource_visions
SET layout_version = 'resource-layout-v1'
WHERE layout_version IS NULL;

ALTER TABLE flag_resource_visions
  ALTER COLUMN layout_version SET DEFAULT 'resource-layout-v1',
  ALTER COLUMN layout_version SET NOT NULL;

ALTER TABLE flag_resource_visions
  DROP CONSTRAINT IF EXISTS flag_resource_visions_layout_version_valid;

ALTER TABLE flag_resource_visions
  ADD CONSTRAINT flag_resource_visions_layout_version_valid
  CHECK (layout_version IN ('resource-layout-v1', 'resource-layout-v2'));
