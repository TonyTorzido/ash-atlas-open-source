-- Authoritative 60-slot manor storage.
--
-- The legacy table stored one aggregate row per item/variant. Preserve its
-- contents, split them by the current item definition max_stack, and promote
-- the first 60 legal stacks into the live grid. Any legacy excess is retained
-- in an explicitly read-only overflow ledger instead of being truncated.

ALTER TABLE manor_storage_stacks RENAME TO manor_storage_stacks_legacy;

CREATE TABLE manor_storage_stacks (
  stack_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
  slot_index integer NOT NULL CHECK (slot_index BETWEEN 0 AND 59),
  item_id text NOT NULL REFERENCES item_definitions(item_id),
  variant text NOT NULL DEFAULT 'default',
  quantity bigint NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991::bigint),
  manual_split boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991::bigint),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manor_storage_stacks_slot_unique
    UNIQUE (manor_id, slot_index) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX manor_storage_stacks_identity_idx
  ON manor_storage_stacks (manor_id, item_id, variant, manual_split, slot_index);

CREATE TABLE manor_storage_overflow (
  stack_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
  source_order integer NOT NULL CHECK (source_order >= 60),
  item_id text NOT NULL REFERENCES item_definitions(item_id),
  variant text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991::bigint),
  legacy_version bigint NOT NULL CHECK (legacy_version > 0),
  reason text NOT NULL DEFAULT 'legacy_backfill_exceeded_60_slots'
    CHECK (reason = 'legacy_backfill_exceeded_60_slots'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manor_id, source_order)
);

CREATE OR REPLACE FUNCTION reject_manor_storage_overflow_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manor storage overflow is migration-retained and read-only';
END;
$$ LANGUAGE plpgsql;

CREATE TEMP TABLE manor_storage_backfill ON COMMIT DROP AS
WITH source AS (
  SELECT legacy.manor_id,
         legacy.item_id,
         legacy.variant,
         legacy.quantity,
         legacy.version,
         definition.display_name,
         COALESCE(definition.max_stack::bigint, legacy.quantity) AS max_stack
  FROM manor_storage_stacks_legacy legacy
  JOIN item_definitions definition ON definition.item_id = legacy.item_id
  WHERE legacy.quantity > 0
),
expanded AS (
  SELECT source.*,
         part
  FROM source
  CROSS JOIN LATERAL generate_series(
    1::bigint,
    ((source.quantity + source.max_stack - 1) / source.max_stack)::bigint
  ) AS part
),
numbered AS (
  SELECT expanded.*,
         row_number() OVER (
           PARTITION BY manor_id
           ORDER BY lower(display_name) COLLATE "C", variant COLLATE "C", item_id COLLATE "C", part
         ) - 1 AS slot_index
  FROM expanded
)
SELECT manor_id,
       slot_index::integer,
       item_id,
       variant,
       LEAST(max_stack, quantity - ((part - 1) * max_stack)) AS quantity,
       version
FROM numbered;

INSERT INTO manor_storage_stacks (
  manor_id, slot_index, item_id, variant, quantity, manual_split, version
)
SELECT manor_id, slot_index, item_id, variant, quantity, false, version
FROM manor_storage_backfill
WHERE slot_index < 60
ORDER BY manor_id, slot_index;

INSERT INTO manor_storage_overflow (
  manor_id, source_order, item_id, variant, quantity, legacy_version
)
SELECT manor_id, slot_index, item_id, variant, quantity, version
FROM manor_storage_backfill
WHERE slot_index >= 60
ORDER BY manor_id, slot_index;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT manor_id, item_id, variant, sum(quantity) AS quantity
      FROM manor_storage_stacks_legacy
      WHERE quantity > 0
      GROUP BY manor_id, item_id, variant
    ) legacy
    FULL JOIN (
      SELECT manor_id, item_id, variant, sum(quantity) AS quantity
      FROM (
        SELECT manor_id, item_id, variant, quantity FROM manor_storage_stacks
        UNION ALL
        SELECT manor_id, item_id, variant, quantity FROM manor_storage_overflow
      ) preserved
      GROUP BY manor_id, item_id, variant
    ) migrated USING (manor_id, item_id, variant)
    WHERE legacy.quantity IS DISTINCT FROM migrated.quantity
  ) THEN
    RAISE EXCEPTION 'manor storage backfill quantity validation failed';
  END IF;
END;
$$;

DROP TABLE manor_storage_stacks_legacy;

CREATE TRIGGER manor_storage_overflow_immutable
BEFORE INSERT OR UPDATE OR DELETE ON manor_storage_overflow
FOR EACH ROW EXECUTE FUNCTION reject_manor_storage_overflow_mutation();

CREATE OR REPLACE FUNCTION validate_manor_storage_stack()
RETURNS trigger AS $$
DECLARE
  maximum_stack bigint;
BEGIN
  SELECT COALESCE(max_stack::bigint, 9007199254740991::bigint)
  INTO maximum_stack
  FROM item_definitions
  WHERE item_id = NEW.item_id;

  IF maximum_stack IS NULL OR NEW.quantity > maximum_stack THEN
    RAISE EXCEPTION 'Manor storage stack exceeds item max_stack'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manor_storage_stack_maximum
BEFORE INSERT OR UPDATE OF item_id, quantity ON manor_storage_stacks
FOR EACH ROW EXECUTE FUNCTION validate_manor_storage_stack();

CREATE TABLE manor_storage_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (
    action IN ('move', 'split', 'restack', 'reorganize', 'transfer', 'bulk_store', 'bulk_take')
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  original_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (player_id, request_id),
  CHECK ((original_result IS NULL) = (completed_at IS NULL))
);

CREATE INDEX manor_storage_operations_manor_created_idx
  ON manor_storage_operations (manor_id, created_at DESC);

CREATE TABLE manor_storage_stack_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL REFERENCES manor_storage_operations(operation_key) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  action text NOT NULL,
  stack_id uuid,
  related_stack_id uuid,
  item_id text REFERENCES item_definitions(item_id),
  variant text,
  slot_before integer,
  slot_after integer,
  quantity_before bigint,
  quantity_after bigint,
  manual_split_before boolean,
  manual_split_after boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX manor_storage_stack_events_operation_idx
  ON manor_storage_stack_events (operation_key, id);
CREATE INDEX manor_storage_stack_events_manor_created_idx
  ON manor_storage_stack_events (manor_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION reject_manor_storage_stack_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manor storage stack events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manor_storage_stack_events_immutable
BEFORE UPDATE OR DELETE ON manor_storage_stack_events
FOR EACH ROW EXECUTE FUNCTION reject_manor_storage_stack_event_mutation();
