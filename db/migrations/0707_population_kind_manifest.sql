-- Separate the shared durable-row schema from per-kind content revisions.
-- Existing generations remain untouched and continue through the compatible
-- legacy reader. Only newly materialized generations record this identity.

ALTER TABLE population_zone_generations_v2
  ADD COLUMN common_schema_revision text NULL
    CHECK (
      common_schema_revision IS NULL
      OR btrim(common_schema_revision) <> ''
    );

CREATE TABLE population_generation_kind_manifest_v2 (
  generation_id uuid NOT NULL
    REFERENCES population_zone_generations_v2(generation_id)
    ON DELETE RESTRICT,
  kind_key text NOT NULL CHECK (
    btrim(kind_key) <> ''
    AND char_length(kind_key) <= 64
    AND kind_key ~ '^[a-z][a-z0-9_]*$'
  ),
  placement_revision text NOT NULL CHECK (
    btrim(placement_revision) <> ''
  ),
  lifecycle_revision text NOT NULL CHECK (
    btrim(lifecycle_revision) <> ''
  ),
  source text NOT NULL CHECK (
    source IN ('generation', 'top_up')
  ),
  group_atomic boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    generation_id,
    kind_key,
    placement_revision,
    lifecycle_revision
  )
);

CREATE INDEX population_generation_kind_manifest_v2_diagnostics_idx
  ON population_generation_kind_manifest_v2 (
    kind_key,
    placement_revision,
    lifecycle_revision,
    generation_id
  );

COMMENT ON COLUMN
  population_zone_generations_v2.common_schema_revision IS
  'Shared durable Population V2 row/read contract; independent of per-kind placement and lifecycle revisions.';

COMMENT ON TABLE population_generation_kind_manifest_v2 IS
  'Per-kind revision manifest for new generations and explicit top-ups; absence preserves legacy-reader compatibility and never blocks generation servability.';
