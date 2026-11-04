CREATE TABLE player_package_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_by_subject text NOT NULL CHECK (length(created_by_subject) BETWEEN 1 AND 320),
  created_by_player_id text NULL REFERENCES players(id) ON DELETE SET NULL,
  target_mode text NOT NULL CHECK (target_mode IN ('all', 'specific')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  message text NOT NULL CHECK (length(message) <= 280),
  recipient_count integer NOT NULL CHECK (recipient_count > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES player_package_campaigns(id) ON DELETE CASCADE,
  recipient_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'unopened'
    CHECK (status IN ('unopened', 'partial', 'claimed')),
  read_at timestamptz NULL,
  first_claimed_at timestamptz NULL,
  claimed_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, recipient_player_id),
  CHECK ((status = 'claimed') = (claimed_at IS NOT NULL)),
  CHECK (first_claimed_at IS NULL OR first_claimed_at >= created_at),
  CHECK (claimed_at IS NULL OR claimed_at >= first_claimed_at)
);

CREATE TABLE player_package_items (
  package_id uuid NOT NULL REFERENCES player_packages(id) ON DELETE CASCADE,
  line_number smallint NOT NULL CHECK (line_number BETWEEN 1 AND 24),
  item_kind text NOT NULL CHECK (item_kind IN ('resource', 'consumable', 'equipment')),
  canonical_item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NULL CHECK (variant IS NULL OR length(variant) BETWEEN 1 AND 80),
  original_quantity bigint NOT NULL CHECK (original_quantity BETWEEN 1 AND 10000),
  remaining_quantity bigint NOT NULL CHECK (
    remaining_quantity BETWEEN 0 AND original_quantity
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (package_id, line_number)
);

CREATE UNIQUE INDEX player_package_items_identity_idx
  ON player_package_items (
    package_id,
    item_kind,
    canonical_item_id,
    COALESCE(variant, '')
  );

CREATE TABLE player_package_claim_operations (
  request_id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES player_packages(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CHECK ((result IS NULL) = (completed_at IS NULL))
);

CREATE INDEX player_packages_recipient_inbox_idx
  ON player_packages (recipient_player_id, created_at DESC, id);
CREATE INDEX player_packages_recipient_unclaimed_idx
  ON player_packages (recipient_player_id, created_at DESC)
  WHERE status <> 'claimed';
CREATE INDEX player_packages_campaign_status_idx
  ON player_packages (campaign_id, status);
CREATE INDEX player_package_campaigns_created_idx
  ON player_package_campaigns (created_at DESC, id);
CREATE INDEX player_package_claim_operations_player_idx
  ON player_package_claim_operations (player_id, created_at DESC);

ALTER TABLE equipment_operations
  DROP CONSTRAINT IF EXISTS equipment_operations_action_check;
ALTER TABLE equipment_operations
  ADD CONSTRAINT equipment_operations_action_check
  CHECK (action IN ('starter_loadout', 'equip', 'unequip', 'package_grant'));

DROP INDEX IF EXISTS equipment_starter_definition_once_idx;
